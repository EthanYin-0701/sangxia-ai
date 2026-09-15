import type { AgentSideConnection, ToolKind } from "@zed-industries/agent-client-protocol";
import type { ToolSchema } from "../llm/types.js";
import type { Session } from "../session.js";

/** Runtime context handed to a tool on each invocation. */
export interface ToolContext {
  conn: AgentSideConnection;
  session: Session;
  signal: AbortSignal;
}

/** Result of running a tool. `output` is fed back to the model and shown to the client. */
export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Optional structured payload surfaced to the client as `rawOutput`. */
  raw?: Record<string, unknown>;
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

  /** Human-readable one-line title for a specific invocation (shown in the client). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  title(args: any): string;

  /** File locations this call touches, enabling client "follow-along". */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locations?(args: any, session: Session): { path: string; line?: number }[];

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
