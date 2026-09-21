import type { AgentSideConnection } from "@zed-industries/agent-client-protocol";
import type { PermissionDecision, Session } from "../session.js";
import type { Tool } from "./tool.js";

/**
 * Ask the client for permission to run a tool, honoring any remembered
 * "always" decision for that tool within the session.
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
  opts: { ignoreRemembered?: boolean } = {},
): Promise<PermissionDecision> {
  if (signal?.aborted) return "reject";
  const remembered = opts.ignoreRemembered ? undefined : session.permissions.get(tool.name);
  if (remembered) return remembered;

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
        { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
        { optionId: "reject_once", name: "拒绝一次", kind: "reject_once" },
        { optionId: "reject_always", name: "总是拒绝", kind: "reject_always" },
      ],
    })]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  if (!res || signal?.aborted || res.outcome.outcome === "cancelled") return "reject";

  switch (res.outcome.optionId) {
    case "allow_always":
      session.permissions.set(tool.name, "allow");
      return "allow";
    case "reject_always":
      session.permissions.set(tool.name, "reject");
      return "reject";
    case "allow_once":
      return "allow";
    default:
      return "reject";
  }
}
