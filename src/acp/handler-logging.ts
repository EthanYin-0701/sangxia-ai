import { RequestError } from "@agentclientprotocol/sdk";
import { logger } from "../logger.js";

/** Session a request is about, for routing the log line. */
function sessionIdOf(params: unknown): string | undefined {
  const id = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Wrap one ACP app handler: run it inside its session's log scope, log a
 * failure ourselves, then rethrow so the SDK still answers with the same
 * JSON-RPC error (SA-65).
 *
 * SDK 2.x no longer prints request-handler errors anywhere, which would leave
 * an editor's "Internal error" with no trace. `RequestError`s are the agent's
 * own deliberate answers (unknown session, auth required, …) and go to `warn`;
 * anything else is a bug and goes to `error` with its stack.
 *
 * Wrapping at the dispatch boundary (not inside each `SangxiaAgent` method)
 * means internal calls such as `setSessionConfigOption` → `setSessionModel`
 * log only once. The label is the wire method (`ctx.method`), which for the
 * `"*"` fallback is the actual extension method name.
 */
export function withHandlerErrorLogging<C extends { method: string; params: unknown }, R>(
  handler: (ctx: C) => R | Promise<R>,
): (ctx: C) => Promise<R> {
  return (ctx) =>
    logger.withSession(sessionIdOf(ctx.params), async () => {
      try {
        return await handler(ctx);
      } catch (e) {
        if (e instanceof RequestError) {
          logger.warn(`ACP ${ctx.method} 返回错误 ${e.code}: ${e.message}`, e.data ?? "");
        } else {
          logger.error(`ACP ${ctx.method} 处理失败:`, e);
        }
        throw e;
      }
    });
}
