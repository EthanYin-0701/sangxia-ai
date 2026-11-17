import { type Agent, RequestError } from "@agentclientprotocol/sdk";
import { logger } from "../logger.js";

/** Every `Agent` handler the SDK may dispatch an incoming request/notification to. */
const ACP_HANDLERS: ReadonlySet<string> = new Set([
  "initialize",
  "newSession",
  "loadSession",
  "unstable_forkSession",
  "unstable_listSessions",
  "unstable_resumeSession",
  "setSessionMode",
  "unstable_setSessionModel",
  "setSessionConfigOption",
  "authenticate",
  "prompt",
  "cancel",
  "extMethod",
  "extNotification",
] satisfies (keyof Agent)[]);

/** Session the call is about, for routing the log line (ext methods carry it in `args[1]`). */
function sessionIdOf(handler: string, args: unknown[]): string | undefined {
  const params = handler === "extMethod" || handler === "extNotification" ? args[1] : args[0];
  const id = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Log every failing ACP handler ourselves, then rethrow so the SDK still
 * answers with the same JSON-RPC error (SA-65).
 *
 * SDK 0.14.1 prints request errors to stderr itself, but never to
 * `SANGXIA_LOG_FILE` / `SANGXIA_LOG_DIR`, and 1.9+ stops printing them at all,
 * which would leave an editor's "Internal error" with no trace. `RequestError`s
 * are the agent's own deliberate answers (unknown session, auth required, …)
 * and go to `warn`; anything else is a bug and goes to `error` with its stack.
 *
 * Wrapping at the dispatch boundary (not inside each method) means internal
 * calls such as `setSessionConfigOption` → `setSessionModel` log only once.
 */
export function withHandlerErrorLogging<T extends Agent>(agent: T): T {
  return new Proxy(agent, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      // Methods run against the real instance: `#private` fields don't exist on the proxy.
      if (typeof prop !== "string" || !ACP_HANDLERS.has(prop)) return value.bind(target);
      return (...args: unknown[]) =>
        logger.withSession(sessionIdOf(prop, args), async () => {
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (e) {
            const label = prop === "extMethod" || prop === "extNotification" ? `${prop}(${String(args[0])})` : prop;
            if (e instanceof RequestError) {
              logger.warn(`ACP ${label} 返回错误 ${e.code}: ${e.message}`, e.data ?? "");
            } else {
              logger.error(`ACP ${label} 处理失败:`, e);
            }
            throw e;
          }
        });
    },
  });
}
