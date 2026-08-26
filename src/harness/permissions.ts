import type { AgentSideConnection } from "@zed-industries/agent-client-protocol";
import type { PermissionDecision, Session } from "../session.js";
import type { Tool } from "./tool.js";

/**
 * Ask the client for permission to run a tool, honoring any remembered
 * "always" decision for that tool within the session.
 *
 * Uses the ACP `session/request_permission` method. If the turn was cancelled
 * mid-request the client returns `cancelled`, which we treat as a rejection.
 */
export async function ensurePermission(
  conn: AgentSideConnection,
  session: Session,
  tool: Tool,
  toolCallId: string,
  title: string,
  rawInput: Record<string, unknown>,
): Promise<PermissionDecision> {
  const remembered = session.permissions.get(tool.name);
  if (remembered) return remembered;

  const res = await conn.requestPermission({
    sessionId: session.id,
    toolCall: { toolCallId, title, kind: tool.kind, rawInput },
    options: [
      { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
      { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
      { optionId: "reject_once", name: "拒绝一次", kind: "reject_once" },
      { optionId: "reject_always", name: "总是拒绝", kind: "reject_always" },
    ],
  });

  if (res.outcome.outcome === "cancelled") return "reject";

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
