import type { AgentSideConnection, ToolKind } from "@agentclientprotocol/sdk";
import type { ToolSchema } from "../llm/types.js";
import type { Session } from "../session.js";

/** Runtime context handed to a tool on each invocation. */
export interface ToolContext {
  conn: AgentSideConnection;
  session: Session;
  signal: AbortSignal;
}

/** Raised when the harness-level tool deadline fires (M3). */
export class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`工具执行超时 (${timeoutMs}ms)`);
    this.name = "ToolTimeoutError";
  }
}

/** Result of running a tool. `output` is fed back to the model and shown to the client. */
export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Optional structured payload surfaced to the client as `rawOutput`. */
  raw?: Record<string, unknown>;
}

/**
 * What a single invocation's permission decision is about (SA-1).
 *
 * "Always allow/reject" used to be remembered per tool name, so one approved
 * `npm test` silently approved every later `bash` call. A scope narrows the
 * memory to e.g. `bash` + command prefix or `write_file` + directory.
 */
export interface PermissionScope {
  /** Memory keys consulted for this call, most specific first. */
  lookup: string[];
  /** Key written when the user picks "always allow / always reject". */
  remember: string;
  /** Human-readable scope shown next to the "always" options. */
  label?: string;
  /**
   * Reason this call must prompt even in `auto` mode and for
   * `needsPermission: false` tools (path outside the workspace, high-risk
   * command). Shown in the permission title.
   */
  forceAsk?: string;
  /** Ignore remembered decisions this once (high-risk commands). */
  ignoreRemembered?: boolean;
}

/**
 * A capability the agent exposes to the LLM as a callable function.
 *
 * `args` is typed as `any` deliberately: it's whatever the model produced,
 * validated by JSON Schema in the harness before permission or execution.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  /** Whether a `session/request_permission` prompt is required before running. */
  readonly needsPermission: boolean;
  /** JSON Schema for the tool's parameters. */
  readonly parameters: Record<string, unknown>;

  /**
   * Optional default deadline for a single invocation. Unset built-ins fall
   * back to `agent.toolTimeoutMs`; MCP tools are covered by that default.
   */
  readonly timeoutMs?: number;

  /** Human-readable one-line title for a specific invocation (shown in the client). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  title(args: any): string;

  /** File locations this call touches, enabling client "follow-along". */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locations?(args: any, session: Session): { path: string; line?: number }[];

  /**
   * Fine-grained permission scope for one invocation. Unset = the whole tool
   * is one scope (MCP tools, `use_skill`, …), keyed by `name`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  permissionScope?(args: any, session: Session): PermissionScope | Promise<PermissionScope>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const t of tools) this.#tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** The tool schemas advertised to the LLM. */
  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}
