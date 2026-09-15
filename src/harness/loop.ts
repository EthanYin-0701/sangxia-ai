import type { AgentSideConnection, PromptResponse } from "@zed-industries/agent-client-protocol";
import type { AgentConfig } from "../config.js";
import type { ChatMessage, LLMProvider, ToolCallRequest } from "../llm/types.js";
import { logger } from "../logger.js";
import type { Session } from "../session.js";
import { saveSession } from "../persistence.js";
import { ensurePermission } from "./permissions.js";
import type { ToolRegistry } from "./tool.js";
import type { PermissionDecision } from "../session.js";
import { validateToolArguments } from "./validation.js";

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
          // H1①: this path only runs on turn-open repair, i.e. an interruption
          // (crash / kill / cancel) from a *previous* process. The process may
          // have died after the tool actually ran (bash committed, MCP opened a
          // ticket), so claiming "未执行" would invite a duplicate side effect.
          // Step 9 refines this into "可安全重试" for calls that never started.
          content:
            "Error: 该工具调用的结果未知（进程在工具执行期间中断）。若该操作可能有副作用，请先核实外部状态，再决定是否重试。",
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
 * repeat until a valid final answer (`end_turn`), truncation (`max_tokens`),
 * error/filter (`refusal`), cancellation or the iteration cap.
 */
export async function runTurn(opts: RunTurnOptions): Promise<StopReason> {
  const { conn, session, provider, tools, config, signal } = opts;
  const startedAt = Date.now();
  let recoveredEmpty = false;
  let warnedHistory = false;

  // Repair any history an interrupted turn left inconsistent (assistant
  // tool_calls without matching tool responses), otherwise OpenAI-compatible
  // endpoints reject the request with a 400.
  const before = session.messages.length;
  const repaired = sanitizeHistory(session.messages);
  if (repaired.length !== before || repaired.some((m, i) => m !== session.messages[i])) {
    logger.warn(
      `turn ${session.id} 历史不完整，已修复 ${before} → ${repaired.length} 条 ` +
        `(取消/中断遗留的 tool_calls 已补齐占位响应)`,
    );
    session.messages = repaired;
    await persistTurn(session);
  }

  for (let iter = 0; iter < config.maxIterations; iter++) {
    if (signal.aborted) return "cancelled";
    if (!warnedHistory && session.messages.length >= config.historyWarningMessages) {
      warnedHistory = true;
      logger.warn(`历史上下文较大 messages=${session.messages.length} threshold=${config.historyWarningMessages}；保留完整工具配对，建议开始新会话`);
    }

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
    let reasoningChars = 0;
    let rawFinishReason: string | null | undefined;

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
            reasoningChars += ev.text.length;
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
            rawFinishReason = ev.rawFinishReason;
            break;
        }
      }
    } catch (e) {
      if (signal.aborted) return "cancelled";
      logger.error("LLM 流式请求失败:", e);
      const msg = e instanceof Error ? e.message : String(e);
      await safeSessionUpdate(conn, {
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n[错误] 调用模型失败: ${msg}` } },
      });
      return "refusal";
    }

    logger.info(
      `turn ${session.id} iteration=${iter + 1} completed ` +
        `textChars=${text.length} reasoningChars=${reasoningChars} toolCalls=${toolCalls.length} ` +
        `finishReason=${finishReason ?? "none"} rawFinishReason=${JSON.stringify(rawFinishReason)}`,
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

    const notice = async (message: string) => {
      session.messages.push({ role: "assistant", content: message });
      await persistTurn(session);
      await safeSessionUpdate(conn, {
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${message}` } },
      });
    };
    if (signal.aborted || (finishReason !== "stop" && finishReason !== "tool_calls")) {
      for (const call of toolCalls) {
        await pushToolResult(session, call.id, "Error: 响应被截断、过滤或中断，工具调用未执行");
        await safeSessionUpdate(conn, { sessionId: session.id, update: {
          sessionUpdate: "tool_call", toolCallId: call.id, title: call.name, kind: "other", status: "failed",
        } });
      }
      if (signal.aborted) return "cancelled";
      if (finishReason === "length") {
        await notice("[输出被截断] 模型达到输出 Token 上限，请调整 maxTokens 或缩小任务后继续。");
        return "max_tokens";
      }
      await notice(finishReason === "content_filter"
        ? "[请求被过滤] 模型服务端阻止了本次响应。"
        : "[模型协议异常] 响应缺少有效的结束原因，已停止执行。");
      return "refusal";
    }
    if (toolCalls.length === 0) {
      if (!text.trim() && finishReason === "stop") {
        if (!recoveredEmpty && iter + 1 < config.maxIterations) {
          recoveredEmpty = true;
          session.messages.push({ role: "user", content: "上次响应未产生正文，请直接输出最终回答或发起标准工具调用。" });
          await persistTurn(session);
          continue;
        }
        await notice("[模型响应为空] 未获得正文或标准工具调用，已停止重试。");
        return "refusal";
      }
      if (finishReason !== "stop") {
        await notice("[模型协议异常] 模型声明工具调用结束，但未返回标准工具调用。");
        return "refusal";
      }
      if (/<function_call\b|```(?:json)?\s*\{\s*"tool"\s*:/i.test(text)) {
        logger.warn(`turn ${session.id} 正文包含疑似工具调用示例，仅诊断、不执行`);
      }
      return "end_turn";
    }

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
    if (signal.aborted) return "cancelled";
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
  let argumentError: string | null = null;
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
    if (tool) argumentError = validateToolArguments(tool, args);
  } catch {
    argumentError = "工具参数不是合法 JSON";
  }
  if (argumentError) {
    logger.warn(`工具 ${call.name} 参数校验失败`);
    await safeSessionUpdate(conn, { sessionId: session.id, update: {
      sessionUpdate: "tool_call", toolCallId, title: call.name, kind: tool?.kind ?? "other", status: "failed",
    } });
    await pushToolResult(session, toolCallId, `Error: ${argumentError}`);
    return;
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
      decision = await ensurePermission(conn, session, tool, toolCallId, title, args, signal);
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
    signal.throwIfAborted();
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
