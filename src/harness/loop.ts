import type { AgentSideConnection, PromptResponse } from "@zed-industries/agent-client-protocol";
import type { AgentConfig } from "../config.js";
import type { ChatMessage, LLMProvider, ToolCallRequest } from "../llm/types.js";
import { logger } from "../logger.js";
import type { Session } from "../session.js";
import { saveSession } from "../persistence.js";
import { ensurePermission } from "./permissions.js";
import type { ToolRegistry } from "./tool.js";
import type { PermissionDecision } from "../session.js";

export type StopReason = PromptResponse["stopReason"];

/** Max characters of a tool result surfaced to the client / fed back to the model. */
const MAX_TOOL_OUTPUT = 100_000;

/**
 * Repair a message history that an interrupted turn left inconsistent.
 *
 * OpenAI-compatible endpoints reject any assistant message whose `tool_calls`
 * are not all answered by following `tool` messages ("insufficient tool
 * messages following tool_calls"). A cancel, a crash inside a tool call, or a
 * permission flow that throws can leave exactly that shape behind, because the
 * assistant message is persisted before its tool results are. This patches the
 * missing responses with placeholder tool messages and drops orphan `tool`
 * messages, so the next request is accepted again.
 */
export function sanitizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // tool_call ids of the current assistant message still awaiting a response.
  let pending: string[] | null = null;

  const flushPending = () => {
    if (pending && pending.length > 0) {
      for (const id of pending) {
        out.push({
          role: "tool",
          tool_call_id: id,
          content: "Error: 工具调用未执行（turn 被取消或中断）",
        });
      }
    }
    pending = null;
  };

  for (const m of messages) {
    if (m.role === "assistant") {
      flushPending();
      if (m.tool_calls && m.tool_calls.length > 0) {
        pending = m.tool_calls.map((tc) => tc.id);
      }
      out.push(m);
    } else if (m.role === "tool") {
      const id = m.tool_call_id;
      if (id && pending && pending.includes(id)) {
        pending = pending.filter((pendingId) => pendingId !== id);
        out.push(m);
      } else {
        logger.warn(`丢弃孤立的 tool 消息（无对应的 tool_call_id=${id}）`);
      }
    } else {
      // user / system messages terminate any still-open tool-call group.
      flushPending();
      out.push(m);
    }
  }
  flushPending();
  return out;
}

/**
 * Send a session update to the client without letting a broken connection
 * abort the tool execution — the tool result must still reach the history.
 */
async function safeSessionUpdate(
  conn: AgentSideConnection,
  update: Parameters<AgentSideConnection["sessionUpdate"]>[0],
): Promise<void> {
  try {
    await conn.sessionUpdate(update);
  } catch (e) {
    logger.warn(`sessionUpdate 发送失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface RunTurnOptions {
  conn: AgentSideConnection;
  session: Session;
  provider: LLMProvider;
  tools: ToolRegistry;
  config: AgentConfig;
  signal: AbortSignal;
}

/**
 * The agent harness — one prompt turn.
 *
 * Loops: ask the LLM → stream text → run any tool calls → feed results back →
 * repeat, until the model stops calling tools (`end_turn`), the turn is
 * cancelled (`cancelled`), or the iteration cap is hit (`max_turn_requests`).
 */
export async function runTurn(opts: RunTurnOptions): Promise<StopReason> {
  const { conn, session, provider, tools, config, signal } = opts;
  const startedAt = Date.now();

  // Repair any history an interrupted turn left inconsistent (assistant
  // tool_calls without matching tool responses), otherwise OpenAI-compatible
  // endpoints reject the request with a 400.
  const before = session.messages.length;
  const repaired = sanitizeHistory(session.messages);
  if (repaired.length !== before) {
    logger.warn(
      `turn ${session.id} 历史不完整，已修复 ${before} → ${repaired.length} 条 ` +
        `(取消/中断遗留的 tool_calls 已补齐占位响应)`,
    );
    session.messages = repaired;
    await persistTurn(session);
  }

  for (let iter = 0; iter < config.maxIterations; iter++) {
    if (signal.aborted) return "cancelled";

    logger.info(
      `turn ${session.id} iteration=${iter + 1}/${config.maxIterations} ` +
        `messages=${session.messages.length}`,
    );

    // Give ACP clients immediate feedback while the provider is waiting for
    // headers/first token (reasoning models can take a noticeable amount of
    // time before producing visible text).
    await safeSessionUpdate(conn, {
      sessionId: session.id,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "（模型处理中…）" } },
    });

    let text = "";
    let toolCalls: ToolCallRequest[] = [];
    let finishReason: string | null = null;

    try {
      for await (const ev of provider.streamChat({
        messages: session.messages,
        tools: tools.schemas(),
        signal,
      })) {
        if (signal.aborted) return "cancelled";
        switch (ev.type) {
          case "text-delta":
            text += ev.text;
            await conn.sessionUpdate({
              sessionId: session.id,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ev.text } },
            });
            break;
          case "reasoning-delta":
            await conn.sessionUpdate({
              sessionId: session.id,
              update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: ev.text } },
            });
            break;
          case "tool-calls":
            toolCalls = ev.calls;
            break;
          case "done":
            finishReason = ev.finishReason;
            break;
        }
      }
    } catch (e) {
      if (signal.aborted) return "cancelled";
      logger.error("LLM 流式请求失败:", e);
      const msg = e instanceof Error ? e.message : String(e);
      await conn.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n[错误] 调用模型失败: ${msg}` } },
      });
      return "refusal";
    }

    logger.info(
      `turn ${session.id} iteration=${iter + 1} completed ` +
        `textChars=${text.length} toolCalls=${toolCalls.length} finishReason=${finishReason ?? "none"}`,
    );
    if (text.length === 0 && toolCalls.length === 0) {
      logger.warn(`turn ${session.id} 模型返回空的可见内容（可能只有 reasoning 或被服务端过滤）`);
    }

    // Record the assistant turn (text + any tool calls) in history.
    session.messages.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    await persistTurn(session);

    if (toolCalls.length === 0) return "end_turn";

    // Execute tool calls sequentially.
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      if (signal.aborted) {
        // Keep the persisted history consistent: every tool_call in the
        // assistant message must have a matching tool response.
        const remaining = toolCalls.slice(i);
        logger.warn(`turn ${session.id} 被取消，剩余 ${remaining.length} 个工具调用未执行`);
        for (const c of remaining) {
          await pushToolResult(session, c.id, "Error: 工具调用未执行（turn 被取消）");
        }
        return "cancelled";
      }
      await executeToolCall(call, opts);
    }
    // Loop again so the model can react to the tool results.
  }

  logger.warn(
    `达到 maxIterations=${config.maxIterations}，提前结束 ` +
      `(elapsedMs=${Date.now() - startedAt}, messages=${session.messages.length})`,
  );
  return "max_turn_requests";
}

async function executeToolCall(call: ToolCallRequest, opts: RunTurnOptions): Promise<void> {
  const { conn, session, tools, config, signal } = opts;
  const toolCallId = call.id;
  const tool = tools.get(call.name);
  const startedAt = Date.now();
  logger.info(
    `tool_call ${session.id} id=${call.id} name=${call.name} ` +
      `argsChars=${call.arguments.length}`,
  );

  let args: Record<string, unknown> = {};
  try {
    args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    logger.warn(`工具 ${call.name} 参数不是合法 JSON: ${call.arguments}`);
  }

  if (!tool) {
    await safeSessionUpdate(conn, {
      sessionId: session.id,
      update: { sessionUpdate: "tool_call", toolCallId, title: `未知工具 ${call.name}`, kind: "other", status: "failed", rawInput: args },
    });
    await pushToolResult(session, toolCallId, `Error: 未知工具 ${call.name}`);
    return;
  }

  const title = safeTitle(tool, args);
  const locations = safeLocations(tool, args, session);

  // Announce the tool call (in progress). A failing update must never block
  // the tool result from reaching the history.
  await safeSessionUpdate(conn, {
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind: tool.kind,
      status: "in_progress",
      rawInput: args,
      ...(locations ? { locations } : {}),
    },
  });

  // Permission gate for mutating tools.
  if (tool.needsPermission && session.permissionMode !== "auto") {
    let decision: PermissionDecision = "reject";
    try {
      decision = await ensurePermission(conn, session, tool, toolCallId, title, args);
    } catch (e) {
      logger.error(`工具 ${tool.name} 权限确认失败，按拒绝处理: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (decision === "reject") {
      await emitToolUpdate(conn, session, toolCallId, "failed", "用户拒绝了该操作");
      await pushToolResult(session, toolCallId, "Error: 用户拒绝执行此工具");
      return;
    }
  }

  // Run it.
  try {
    const result = await tool.run(args, { conn, session, signal });
    const output = truncate(result.output);
    await safeSessionUpdate(conn, {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: result.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: output || "(无输出)" } }],
        ...(result.raw ? { rawOutput: result.raw } : {}),
      },
    });
    await pushToolResult(session, toolCallId, output || "(无输出)");
    logger.info(
      `tool_call ${session.id} id=${toolCallId} name=${tool.name} ` +
        `status=${result.isError ? "failed" : "completed"} ` +
        `outputChars=${output.length} elapsedMs=${Date.now() - startedAt}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`工具 ${tool.name} 执行异常:`, e);
    await emitToolUpdate(conn, session, toolCallId, "failed", msg);
    await pushToolResult(session, toolCallId, `Error: ${msg}`);
    logger.info(
      `tool_call ${session.id} id=${toolCallId} name=${tool.name} ` +
        `status=failed elapsedMs=${Date.now() - startedAt}`,
    );
  }
}

async function pushToolResult(session: Session, toolCallId: string, content: string): Promise<void> {
  session.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  await persistTurn(session);
}

async function persistTurn(session: Session): Promise<void> {
  try {
    await saveSession({
      version: 1,
      sessionId: session.id,
      cwd: session.cwd,
      messages: session.messages,
      permissionMode: session.permissionMode,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    logger.warn(`session ${session.id} 持久化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function emitToolUpdate(
  conn: AgentSideConnection,
  session: Session,
  toolCallId: string,
  status: "completed" | "failed",
  text: string,
): Promise<void> {
  await safeSessionUpdate(conn, {
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      content: [{ type: "content", content: { type: "text", text } }],
    },
  });
}

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  return `${s.slice(0, MAX_TOOL_OUTPUT)}\n…(输出过长，已截断，共 ${s.length} 字符)`;
}

function safeTitle(tool: { title(a: unknown): string; name: string }, args: unknown): string {
  try {
    return tool.title(args);
  } catch {
    return tool.name;
  }
}

function safeLocations(
  tool: { locations?(a: unknown, s: Session): { path: string; line?: number }[] },
  args: unknown,
  session: Session,
): { path: string; line?: number }[] | undefined {
  if (!tool.locations) return undefined;
  try {
    const locs = tool.locations(args, session);
    return locs.length > 0 ? locs : undefined;
  } catch {
    return undefined;
  }
}
