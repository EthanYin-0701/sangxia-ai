import type { AgentSideConnection, PromptResponse } from "@zed-industries/agent-client-protocol";
import type { AgentConfig } from "../config.js";
import { hookPayload, type HookRegistry } from "../hooks/index.js";
import type { HookOutcome } from "../hooks/types.js";
import { ProviderError } from "../llm/types.js";
import type { ChatMessage, LLMProvider, ToolCallRequest } from "../llm/types.js";
import { logger } from "../logger.js";
import type { Session } from "../session.js";
import { persistHistoryReset, persistSession, persistToolEvent } from "../persistence.js";
import { ensurePermission } from "./permissions.js";
import type { Tool, ToolRegistry } from "./tool.js";
import { ToolTimeoutError } from "./tool.js";
import type { PermissionDecision } from "../session.js";
import { validateToolArguments } from "./validation.js";
import { truncateMiddle } from "./truncate.js";
import { calibrateEstimate, estimateTokens } from "./context.js";

export type StopReason = PromptResponse["stopReason"];

/** Max characters of a tool result surfaced to the client / fed back to the model. */
const MAX_TOOL_OUTPUT = 100_000;

/**
 * Separate budget for `post_tool_use` injected context (review L1): a build log
 * already near `MAX_TOOL_OUTPUT` must not squeeze out the hook's feedback,
 * which is exactly the valuable part in that scenario.
 */
const MAX_HOOK_CONTEXT = 40_000;

/** Fallback tool deadline when the config doesn't specify one (agent.toolTimeoutMs). */
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

/**
 * How often to refresh the "still waiting" thought while no delta has
 * arrived yet. A busy DeepSeek endpoint can queue for minutes (see
 * `firstChunkTimeoutMs`); without this, the one-shot "（模型处理中…）" notice
 * looks identical whether the wait is 2s or 8 minutes, which reads as hung.
 */
const WAIT_NOTICE_INTERVAL_MS = 20_000;

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
 *
 * The placeholder wording depends on the evidence in `startedToolCalls`
 * (persisted `tool_started` events):
 *  - the call did start → the process may have died after the side effect, so
 *    the model must verify external state instead of blindly retrying;
 *  - we do have started evidence for this session and the call is not in it →
 *    it provably never ran, so it is safe to retry;
 *  - no evidence at all (empty set, e.g. a log written before started events
 *    existed) → stay conservative: treat the result as unknown.
 */
export function sanitizeHistory(
  messages: ChatMessage[],
  startedToolCalls: ReadonlySet<string> = new Set(),
): ChatMessage[] {
  const out: ChatMessage[] = [];
  // tool_call ids of the current assistant message still awaiting a response.
  let pending: string[] | null = null;
  // An empty set carries no information: "not listed" must not be read as
  // "did not run".
  const hasEvidence = startedToolCalls.size > 0;

  const placeholder = (id: string): string =>
    !hasEvidence || startedToolCalls.has(id)
      ? "Error: 该工具调用的结果未知（进程在工具执行期间中断）。若该操作可能有副作用，请先核实外部状态，再决定是否重试。"
      : "Error: 该工具调用未执行（turn 被取消或中断），可以安全重试。";

  const flushPending = () => {
    if (pending && pending.length > 0) {
      for (const id of pending) {
        out.push({
          role: "tool",
          tool_call_id: id,
          content: placeholder(id),
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
  /**
   * Lifecycle hooks for this session (plan/hooks_support.md). Omitted/`empty`
   * registry means every hook point is a no-op.
   */
  hooks?: HookRegistry;
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
  // H3②(10a): heuristic prompt-size tracking. `lastEstimate` pairs with the
  // provider's reported `prompt_tokens` from the previous request so the next
  // estimate can be calibrated instead of drifting.
  let lastEstimate: number | null = null;
  let toolCallsThisTurn = 0;
  let wrapUpWarned = false;
  /** How many iterations before the cap to inject the wrap-up prompt. */
  const WRAP_UP_MARGIN = 3;

  /** Surface a message to the client *and* into the history in one place. */
  const notice = async (message: string) => {
    session.messages.push({ role: "assistant", content: message });
    await persistSession(session);
    await safeSessionUpdate(conn, {
      sessionId: session.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${message}` } },
    });
  };

  // Repair any history an interrupted turn left inconsistent (assistant
  // tool_calls without matching tool responses), otherwise OpenAI-compatible
  // endpoints reject the request with a 400.
  const before = session.messages.length;
  const repaired = sanitizeHistory(session.messages, session.startedToolCalls);
  if (repaired.length !== before || repaired.some((m, i) => m !== session.messages[i])) {
    logger.warn(
      `turn ${session.id} 历史不完整，已修复 ${before} → ${repaired.length} 条 ` +
        `(取消/中断遗留的 tool_calls 已补齐占位响应)`,
    );
    session.messages = repaired;
    await persistHistoryReset(session);
  }

  for (let iter = 0; iter < config.maxIterations; iter++) {
    // Reported to `turn_end` hooks (agent.ts reads it after runTurn returns).
    session.turnIterations = iter + 1;
    if (signal.aborted) return "cancelled";

    // P0-B: inject a wrap-up prompt when approaching the iteration cap so the
    // model can finish gracefully instead of being hard-cut mid-edit.
    if (
      !wrapUpWarned &&
      config.maxIterations > WRAP_UP_MARGIN &&
      iter === config.maxIterations - WRAP_UP_MARGIN
    ) {
      wrapUpWarned = true;
      session.messages.push({
        role: "user",
        content:
          `[系统提示] 本轮还剩 ${WRAP_UP_MARGIN} 次模型调用。请进入收尾：不要开始新的大改动；` +
          `把已完成/未完成事项更新到 update_plan；如有未验证或未提交的改动请说明；最后用一段话汇报进度。`,
      });
      await persistSession(session);
    }

    if (!session.historyWarned && session.messages.length >= config.historyWarningMessages) {
      session.historyWarned = true; // once per session, not once per iteration
      // H3①: a logger.warn only reaches stderr/log files — neither the user nor
      // the model ever sees it. Notice the user, and put it in the history so the
      // model can factor it in. Keeping `logger.warn` too keeps log assertions.
      logger.warn(`历史上下文较大 messages=${session.messages.length} threshold=${config.historyWarningMessages}；保留完整工具配对，建议开始新会话`);
      await notice(
        `[上下文较大] 当前历史 ${session.messages.length} 条消息（阈值 ${config.historyWarningMessages}）。为保留完整工具配对，本会话不自动裁剪；若后续请求变慢或失败，建议开始新会话。`,
      );
    }

    // Log the estimated prompt size *before* the request: this is the number
    // that later thresholds (compaction) will key off, and it is what makes a
    // real long-running task diagnosable ("is it the context?").
    const schemas = tools.schemas();
    const rawEstimate = estimateTokens(session.messages, schemas);
    const estimatedPromptTokens = calibrateEstimate(rawEstimate, lastEstimate, provider.lastPromptTokens ?? null);
    lastEstimate = estimatedPromptTokens;
    logger.info(
      `turn ${session.id} iteration=${iter + 1}/${config.maxIterations} ` +
        `messages=${session.messages.length} tools=${schemas.length} ` +
        `estimatedPromptTokens=${estimatedPromptTokens} rawEstimate=${rawEstimate} ` +
        `lastPromptTokens=${provider.lastPromptTokens ?? "none"}`,
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
    let reasoning = "";
    let rawFinishReason: string | null | undefined;

    // Keep refreshing the "still waiting" thought with elapsed time until the
    // first event arrives, so a long server-side queue (see
    // firstChunkTimeoutMs) reads as "still going", not "stuck".
    const waitStartedAt = Date.now();
    let firstEventSeen = false;
    const waitNoticeTimer = setInterval(() => {
      if (firstEventSeen) return;
      const waitedS = Math.round((Date.now() - waitStartedAt) / 1000);
      void safeSessionUpdate(conn, {
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `（模型处理中，已等待 ${waitedS}s，可能是服务端排队，最长约 10 分钟…）` },
        },
      });
    }, WAIT_NOTICE_INTERVAL_MS);

    try {
      for await (const ev of provider.streamChat({
        messages: session.messages,
        tools: schemas,
        signal,
      })) {
        firstEventSeen = true;
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
            reasoning += ev.text;
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
      // ProviderError carries a localized, actionable explanation (bad key,
      // insufficient balance, rate limit, …); anything else falls back to the
      // raw SDK/transport message.
      const msg = e instanceof ProviderError ? e.userMessage : e instanceof Error ? e.message : String(e);
      await safeSessionUpdate(conn, {
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n[错误] 调用模型失败: ${msg}` } },
      });
      return "refusal";
    } finally {
      clearInterval(waitNoticeTimer);
    }

    logger.info(
      `turn ${session.id} iteration=${iter + 1} completed ` +
        `textChars=${text.length} reasoningChars=${reasoning.length} toolCalls=${toolCalls.length} ` +
        `finishReason=${finishReason ?? "none"} rawFinishReason=${JSON.stringify(rawFinishReason)} ` +
        `cacheHitRatio=${cacheHitRatio(provider.lastUsage)}`,
    );
    if (text.length === 0 && toolCalls.length === 0) {
      logger.warn(`turn ${session.id} 模型返回空的可见内容（可能只有 reasoning 或被服务端过滤）`);
    }

    // Record the assistant turn (text + any tool calls + reasoning) in
    // history. `reasoning_content` must ride along on every assistant turn
    // (not only ones with tool calls) — see toOpenAIMessages in llm/openai.ts.
    session.messages.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoning_content: reasoning.length > 0 ? reasoning : undefined,
    });
    await persistSession(session);

    if (signal.aborted || (finishReason !== "stop" && finishReason !== "tool_calls")) {
      for (const call of toolCalls) {
        await pushToolResult(session, call.id, "Error: 响应被截断、过滤或中断，工具调用未执行");
        await safeSessionUpdate(conn, { sessionId: session.id, update: {
          sessionUpdate: "tool_call", toolCallId: call.id, title: call.name, kind: "other", status: "failed",
        } });
      }
      if (signal.aborted) return "cancelled";
      if (finishReason === "length") {
        // Name the actual budget: `max_tokens` is a single pool shared by
        // reasoning + visible text + tool-call arguments, so "which limit am I
        // hitting" is the first thing worth knowing. When maxTokens isn't
        // configured we never sent the field at all — the backend's own
        // default applied (e.g. DeepSeek thinking mode: 64K, 128K at
        // reasoning_effort=max) — so say that instead of a bare "unknown".
        const budget = provider.maxTokens
          ? `（maxTokens=${provider.maxTokens}）`
          : "（未设置 provider.maxTokens，使用服务端默认额度；DeepSeek 思考模式默认约 64K，reasoning_effort=max 时约 128K）";
        logger.warn(
          `turn ${session.id} 输出被截断 finishReason=length maxTokens=${provider.maxTokens ?? "server-default"} ` +
            `textChars=${text.length} reasoningChars=${reasoning.length} toolCalls=${toolCalls.length}`,
        );
        await notice(
          `[输出被截断] 模型达到输出 Token 上限${budget}。该额度由「思考过程 + 正文 + 工具参数」共用，` +
            `可显式设置 provider.maxTokens（或按模型在 provider.models[].maxTokens 单独设置）提高上限，也可以缩小任务后继续。`,
        );
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
          await persistSession(session);
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
      toolCallsThisTurn++;
    }
    if (signal.aborted) return "cancelled";
    // Loop again so the model can react to the tool results.
  }

  // P0-A: surface the cap to the client *and* write it into the history so
  // the next "继续" turn can see that it was truncated (saves 4 re-orientation
  // iterations the model would otherwise spend rediscovering context).
  logger.warn(
    `达到 maxIterations=${config.maxIterations}，提前结束 ` +
      `(elapsedMs=${Date.now() - startedAt}, messages=${session.messages.length}, toolCalls=${toolCallsThisTurn})`,
  );
  await notice(
    `[已达迭代上限] 本轮已进行 ${config.maxIterations} 次模型调用、${toolCallsThisTurn} 次工具调用` +
      `（agent.maxIterations=${config.maxIterations}），任务可能未完成。` +
      `回复「继续」可从当前进度接着做；如任务较大，可在配置里调高 agent.maxIterations。`,
  );
  return "max_turn_requests";
}

async function executeToolCall(call: ToolCallRequest, opts: RunTurnOptions): Promise<void> {
  const { conn, session, tools, config, signal, hooks } = opts;
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

  // pre_tool_use runs **before** the announce and before the permission prompt
  // (plan §3 / D1, review M1): the title, locations, `rawInput` shown to the
  // client *and* the parameters the human approves are all derived from the
  // final (possibly hook-rewritten) arguments — "人批准的就是实际执行的".
  // Invalid arguments never reach a hook (they already failed above).
  let askReason: string | undefined;
  let askHookName: string | undefined;
  if (hooks?.has("pre_tool_use")) {
    const outcome = await hooks.run(
      "pre_tool_use",
      hookPayload(session, "pre_tool_use", {
        tool_name: tool.name,
        tool_call_id: toolCallId,
        tool_kind: tool.kind,
        tool_input: args,
        tool_title: safeTitle(tool, args),
      }),
      { signal },
    );
    if (outcome.decision === "deny") {
      const message = hookDenyMessage(hookLabel(outcome, call.name), outcome);
      logger.warn(`tool_call ${session.id} id=${toolCallId} name=${tool.name} 被 hook 拒绝: ${outcome.reason ?? ""}`);
      await safeSessionUpdate(conn, {
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: safeTitle(tool, args),
          kind: tool.kind,
          status: "failed",
          rawInput: args,
          // D13: the client shows the same text the model receives.
          content: [{ type: "content", content: { type: "text", text: `Error: ${message}` } }],
        },
      });
      await pushToolResult(session, toolCallId, `Error: ${message}`);
      return;
    }
    if (outcome.decision === "ask") {
      askHookName = outcome.hookName;
      askReason = outcome.reason;
    }
    if (outcome.updatedInput) {
      // A rewritten input is a *replacement*, so it must pass the same schema
      // check again. Never let a polluted input reach execution (plan §5.2).
      const rewrittenError = validateToolArguments(tool, outcome.updatedInput);
      if (rewrittenError) {
        logger.warn(`hook "${outcome.hookName ?? "?"}" 改写的 tool_input 非法 (${tool.name}): ${rewrittenError}`);
        await safeSessionUpdate(conn, {
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: safeTitle(tool, args),
            kind: tool.kind,
            status: "failed",
            rawInput: outcome.updatedInput,
            content: [{ type: "content", content: { type: "text", text: `Error: hook 改写的参数不合法，未执行该工具: ${rewrittenError}` } }],
          },
        });
        await pushToolResult(
          session,
          toolCallId,
          `Error: hook "${outcome.hookName ?? "?"}" 改写的参数不合法，未执行该工具: ${rewrittenError}`,
        );
        return;
      }
      args = outcome.updatedInput;
      logger.info(`tool_call ${session.id} id=${toolCallId} 参数被 hook 改写 (${outcome.hookName ?? "?"})`);
    }
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

  // Permission gate for mutating tools — plus the D14 `ask` branch, which
  // deliberately bypasses both conditions of the gate below:
  //   - `permissionMode: "auto"` must still prompt (auto is "don't ask me by
  //     default", it cannot silently swallow a hook's explicit "ask me");
  //   - `needsPermission: false` read-only tools (read_file/grep/…) must prompt
  //     too, which is what "读取敏感路径强制复核" is built on;
  //   - `ignoreRemembered` makes a previous "always allow/reject" count for
  //     nothing this once (the user's answer may still be remembered).
  const forcedAsk = askHookName !== undefined;
  if (forcedAsk || (tool.needsPermission && session.permissionMode !== "auto")) {
    let decision: PermissionDecision = "reject";
    try {
      decision = await ensurePermission(
        conn,
        session,
        tool,
        toolCallId,
        forcedAsk && askReason ? `${title}｜hook ${askHookName} 要求确认：${askReason}` : title,
        args,
        signal,
        { ignoreRemembered: forcedAsk },
      );
    } catch (e) {
      logger.error(`工具 ${tool.name} 权限确认失败，按拒绝处理: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (decision === "reject") {
      await emitToolUpdate(conn, session, toolCallId, "failed", "用户拒绝了该操作");
      await pushToolResult(session, toolCallId, "Error: 用户拒绝执行此工具");
      return;
    }
  }

  // Run it, under a harness-level deadline (M3). Tools had no watchdog at all
  // while the LLM had two, so a hung tool blocked the turn forever.
  const requestTimeout = Number(args.timeout);
  const configTimeout = Number(config.toolTimeoutMs);
  const effectiveTimeout = Number.isFinite(requestTimeout) && requestTimeout > 0
    ? requestTimeout
    : tool.timeoutMs ?? (Number.isFinite(configTimeout) && configTimeout > 0 ? configTimeout : DEFAULT_TOOL_TIMEOUT_MS);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ToolTimeoutError(effectiveTimeout)), effectiveTimeout);
  const toolSignal = linkSignals(signal, deadline.signal);
  // H1②: evidence that this call really started. Written *before* tool.run —
  // ordering matters, otherwise a crash during the tool would look identical to
  // a crash before it and repair could only guess.
  let dispatched = false;
  const finishTool = async (toolCallId: string, status: "completed" | "failed") => {
    if (dispatched) await persistToolEvent(session.id, { t: "tool_finished", toolCallId, status });
  };
  try {
    signal.throwIfAborted();
    // Race the tool against its deadline: a tool that ignores the signal (or a
    // promise that simply never settles) must not pin the turn. The harness
    // stops waiting; it cannot force-kill an arbitrary tool, so a non-abortable
    // operation may keep running in the background.
    dispatched = true;
    session.startedToolCalls.add(toolCallId);
    await persistToolEvent(session.id, { t: "tool_started", toolCallId, name: tool.name });
    const pending = tool.run(args, { conn, session, signal: toolSignal.signal });
    pending.catch(() => {}); // losing the race must not surface as unhandled
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const onDeadline = () => reject(toolSignal.signal.reason);
        if (toolSignal.signal.aborted) onDeadline();
        else toolSignal.signal.addEventListener("abort", onDeadline, { once: true });
      }),
    ]);
    // M1: mark failures visibly for the model. Built-in tools prefix errors
    // with "Error:", but MCP tools can return `isError` with arbitrary text
    // ("boom", "no such table") that the model would otherwise read as a
    // successful result. One exit feeds both the client and the history, so the
    // wording can't drift between the two.
    const raw = truncate(result.output) || "(无输出)";
    const output =
      result.isError && !/^(Error:|\[工具执行失败\])/.test(raw) ? `[工具执行失败] ${raw}` : raw;
    const elapsedMs = Date.now() - startedAt;
    // Give the client the tool's own result first (review L1: a 120s typecheck
    // hook must not delay "the tool finished"), then append hook context and
    // send a second update so UI, history and model see the same text.
    await safeSessionUpdate(conn, {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: result.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: output } }],
        ...(result.raw ? { rawOutput: result.raw } : {}),
      },
    });
    const finalOutput = await applyPostToolUse(opts, tool, toolCallId, args, {
      output,
      isError: Boolean(result.isError),
      elapsedMs,
    });
    await pushToolResult(session, toolCallId, finalOutput);
    await finishTool(toolCallId, result.isError ? "failed" : "completed");
    logger.info(
      `tool_call ${session.id} id=${toolCallId} name=${tool.name} ` +
        `status=${result.isError ? "failed" : "completed"} ` +
        `outputChars=${finalOutput.length} elapsedMs=${Date.now() - startedAt}`,
    );
  } catch (e) {
    // User cancellation wins over the deadline: the two must not be confused.
    if (signal.aborted) {
      // Still close the tool_call, or the assistant's tool_calls would be
      // missing a response (the caller only fills in the *remaining* calls).
      logger.info(`turn ${session.id} cancelled during tool ${tool.name}`);
      await pushToolResult(session, toolCallId, "Error: 工具调用未执行（turn 被取消）");
      await finishTool(toolCallId, "failed");
      return;
    }
    if (deadline.signal.aborted) {
      const msg = `工具执行超时（${effectiveTimeout}ms）已终止；可缩小任务范围或显式设置 timeout 后重试`;
      logger.warn(`tool_call ${session.id} id=${toolCallId} name=${tool.name} timeoutMs=${effectiveTimeout}`);
      const output = await applyPostToolUse(opts, tool, toolCallId, args, {
        output: `Error: ${msg}`,
        isError: true,
        elapsedMs: Date.now() - startedAt,
      });
      await emitToolUpdate(conn, session, toolCallId, "failed", output);
      await pushToolResult(session, toolCallId, output);
      await finishTool(toolCallId, "failed");
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`工具 ${tool.name} 执行异常:`, e);
    const output = await applyPostToolUse(opts, tool, toolCallId, args, {
      output: `Error: ${msg}`,
      isError: true,
      elapsedMs: Date.now() - startedAt,
    });
    await emitToolUpdate(conn, session, toolCallId, "failed", output);
    await pushToolResult(session, toolCallId, output);
    await finishTool(toolCallId, "failed");
    logger.info(
      `tool_call ${session.id} id=${toolCallId} name=${tool.name} ` +
        `status=failed elapsedMs=${Date.now() - startedAt}`,
    );
  } finally {
    clearTimeout(timer);
    toolSignal.dispose();
  }
}

/**
 * `post_tool_use` for one **executed** tool call: fold the hooks'
 * `additionalContext` into the tool result text.
 *
 * Denials are ignored here (plan §7.2 — post hooks cannot block); the tool's
 * own result must still reach history. Called from the success path *and* from
 * the timeout/exception paths, so "failed also gets audited" holds. The result
 * text lives in its own budget (review L1) so a huge tool output can't squeeze
 * the hook feedback out.
 */
async function applyPostToolUse(
  opts: RunTurnOptions,
  tool: Tool,
  toolCallId: string,
  args: Record<string, unknown>,
  result: { output: string; isError: boolean; elapsedMs: number },
): Promise<string> {
  const { hooks, session, conn, signal } = opts;
  if (!hooks?.has("post_tool_use") || signal.aborted) return result.output;
  const outcome = await hooks.run(
    "post_tool_use",
    hookPayload(session, "post_tool_use", {
      tool_name: tool.name,
      tool_call_id: toolCallId,
      tool_kind: tool.kind,
      tool_input: args,
      tool_title: safeTitle(tool, args),
      tool_output: truncate(result.output),
      tool_error: result.isError,
      tool_elapsed_ms: result.elapsedMs,
    }),
    { signal },
  );
  if (outcome.additionalContext.length === 0) return result.output;
  const context = truncateMiddle(outcome.additionalContext.join("\n\n"), MAX_HOOK_CONTEXT);
  const finalOutput = `${result.output}\n\n${context}`;
  // Second update so the client shows what the model actually received (L1).
  await safeSessionUpdate(conn, {
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: result.isError ? "failed" : "completed",
      content: [{ type: "content", content: { type: "text", text: finalOutput } }],
    },
  });
  return finalOutput;
}

function hookLabel(outcome: HookOutcome, fallback: string): string {
  return outcome.hookName ?? fallback;
}

/** Tool-result text for a hook denial (D13: `Error:` prefix ⇒ isError semantics). */
function hookDenyMessage(label: string, outcome: HookOutcome): string {
  const reason = outcome.reason?.trim();
  return reason ? `被 hook ${label} 拒绝：${reason}` : `被 hook ${label} 拒绝`;
}

/**
 * Combine two abort signals into one (M3).
 *
 * `AbortSignal.any` would be the obvious tool, but this package declares
 * `node >= 20` and that API only stabilized in 20.3. Listeners are removed in
 * `dispose()` so a long turn can't accumulate them.
 */
function linkSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  const onA = forward(a);
  const onB = forward(b);
  if (a.aborted) onA();
  else a.addEventListener("abort", onA, { once: true });
  if (b.aborted) onB();
  else b.addEventListener("abort", onB, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      a.removeEventListener("abort", onA);
      b.removeEventListener("abort", onB);
    },
  };
}

async function pushToolResult(session: Session, toolCallId: string, content: string): Promise<void> {
  session.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  await persistSession(session);
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
  return truncateMiddle(s, MAX_TOOL_OUTPUT);
}

/**
 * `prompt_cache_hit_tokens / (hit + miss)` as a 2-decimal string, or `n/a`
 * when the backend didn't report cache usage for this request. Cost on
 * DeepSeek is dominated by prompt tokens and the cache/miss price gap is 50x
 * (see plan/deepseek_first_improvements.md §2.3), so this is the single
 * number worth surfacing per turn.
 */
function cacheHitRatio(usage: Record<string, number> | null | undefined): string {
  const hit = usage?.prompt_cache_hit_tokens;
  const miss = usage?.prompt_cache_miss_tokens;
  if (typeof hit !== "number" || typeof miss !== "number" || hit + miss <= 0) return "n/a";
  return (hit / (hit + miss)).toFixed(2);
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
