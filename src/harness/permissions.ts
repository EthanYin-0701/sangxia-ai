import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { logger } from "../logger.js";
import type { PermissionDecision, Session } from "../session.js";
import type { PermissionScope, Tool } from "./tool.js";

/**
 * Compute the permission scope of one invocation (SA-1). Tools without a
 * `permissionScope` are a single scope keyed by their name.
 *
 * Fail closed: if a tool's scope computation throws, the call is forced to
 * prompt and no remembered decision applies.
 */
export async function resolvePermissionScope(
  tool: Tool,
  args: Record<string, unknown>,
  session: Session,
): Promise<PermissionScope> {
  if (!tool.permissionScope) return { lookup: [tool.name], remember: tool.name };
  try {
    return await tool.permissionScope(args, session);
  } catch (e) {
    logger.warn(`工具 ${tool.name} 权限范围计算失败，强制确认: ${e instanceof Error ? e.message : String(e)}`);
    return {
      lookup: [],
      remember: `${tool.name}:unscoped`,
      forceAsk: "无法确定操作范围",
      ignoreRemembered: true,
    };
  }
}

/** First remembered decision matching the scope, if any. */
export function rememberedDecision(session: Session, scope: PermissionScope): PermissionDecision | undefined {
  for (const key of scope.lookup) {
    const decision = session.permissions.get(key);
    if (decision) return decision;
  }
  return undefined;
}

/**
 * Ask the client for permission to run a tool, honoring any remembered
 * "always" decision for the call's {@link PermissionScope} within the session.
 *
 * Uses the ACP `session/request_permission` method. If the turn was cancelled
 * mid-request, either the client response or the turn signal can reject it.
 *
 * `opts.ignoreRemembered` (D14) makes a remembered "always allow/reject" count
 * for nothing this once — that is what a hook's `ask` decision means ("记忆不算
 * 数，这次必须问"). The user's answer may still be written back to the memory
 * map (unless they chose `allow_once` / `reject_once`).
 */
export async function ensurePermission(
  conn: AgentSideConnection,
  session: Session,
  tool: Tool,
  toolCallId: string,
  title: string,
  rawInput: Record<string, unknown>,
  signal?: AbortSignal,
  opts: { ignoreRemembered?: boolean; scope?: PermissionScope } = {},
): Promise<PermissionDecision> {
  if (signal?.aborted) return "reject";
  const scope = opts.scope ?? { lookup: [tool.name], remember: tool.name };
  const remembered = opts.ignoreRemembered ? undefined : rememberedDecision(session, scope);
  if (remembered) return remembered;

  const suffix = scope.label ? `（${scope.label}）` : "";
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let res;
  try {
    res = await Promise.race([cancelled, conn.requestPermission({
      sessionId: session.id,
      toolCall: { toolCallId, title, kind: tool.kind, rawInput },
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "allow_always", name: `总是允许${suffix}`, kind: "allow_always" },
        { optionId: "reject_once", name: "拒绝一次", kind: "reject_once" },
        { optionId: "reject_always", name: `总是拒绝${suffix}`, kind: "reject_always" },
      ],
    })]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  if (!res || signal?.aborted || res.outcome.outcome === "cancelled") return "reject";

  switch (res.outcome.optionId) {
    case "allow_always":
      session.permissions.set(scope.remember, "allow");
      return "allow";
    case "reject_always":
      session.permissions.set(scope.remember, "reject");
      return "reject";
    case "allow_once":
      return "allow";
    default:
      return "reject";
  }
}
