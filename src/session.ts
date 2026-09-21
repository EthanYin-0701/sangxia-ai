import type { McpServer } from "@zed-industries/agent-client-protocol";
import { ToolRegistry } from "./harness/tool.js";
import { HookRegistry } from "./hooks/index.js";
import type { ChatMessage } from "./llm/types.js";
import type { McpConnection } from "./mcp/client.js";
import type { Skill } from "./skills/index.js";
import type { AgentConfig } from "./config.js";

/** Which file/terminal operations the connected client supports. */
export interface ClientCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
}

/** A remembered permission decision for a tool (from "always" choices). */
export type PermissionDecision = "allow" | "reject";
export type PermissionMode = AgentConfig["permissionMode"];

/** Per-conversation state held by the agent. */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly mcpServers: McpServer[];
  readonly clientCaps: ClientCapabilities;

  /** ACP session mode controlling whether mutating tools require confirmation. */
  permissionMode: PermissionMode;

  /** ACP-selectable LLM model for this conversation. */
  modelId: string;

  /** Full LLM conversation history (system + user + assistant + tool). */
  messages: ChatMessage[] = [];

  /** Tool name → remembered allow/reject (set by "allow always" / "reject always"). */
  readonly permissions = new Map<string, PermissionDecision>();

  /** Set while a prompt turn is running; used to cancel. */
  abort: AbortController | null = null;

  /** Whether the large-history notice was already sent this session (H3①). */
  historyWarned = false;

  /**
   * Tool call ids that actually started in a previous run (from the persisted
   * `tool_started` events). Lets repair distinguish "may have run" from
   * "never ran" — see `sanitizeHistory`.
   */
  startedToolCalls = new Set<string>();

  /**
   * Whether a prompt turn is in flight (H2: one turn per session invariant).
   * Kept separate from {@link abort} so other paths can't mistake "abort is
   * set" for "a turn is running".
   */
  promptInFlight = false;

  /** Tools for this session = built-ins + `use_skill` + MCP tools. Populated in `newSession`. */
  tools: ToolRegistry = new ToolRegistry([]);

  /** Live MCP connections opened for this session; closed by {@link dispose}. */
  mcpConnections: McpConnection[] = [];

  /** Skills discovered for this session's cwd (name + description + SKILL.md path). */
  skills: Skill[] = [];

  /** Prevent repeatedly asking about project initialization in one session. */
  initializationChecked = false;

  /**
   * Lifecycle hooks for this session: config-level (paths resolved in
   * `loadConfig`) + optional project-level file. `HookRegistry.empty` when
   * hooks are disabled — `has()` is then a constant false, zero overhead.
   */
  hooks: HookRegistry = HookRegistry.empty;

  /**
   * Text injected by the `session_start` hook (`additionalContext`). Read by
   * `systemPrompt()` so *any* rebuild of the system message carries it
   * (newSession, and the rebuild after project initialization).
   */
  hookContext: string[] = [];

  /** Iterations of the most recent turn — reported to `turn_end` hooks. */
  turnIterations = 0;

  constructor(
    id: string,
    cwd: string,
    mcpServers: McpServer[],
    clientCaps: ClientCapabilities,
    permissionMode: PermissionMode,
    modelId: string,
  ) {
    this.id = id;
    this.cwd = cwd;
    this.mcpServers = mcpServers;
    this.clientCaps = clientCaps;
    this.permissionMode = permissionMode;
    this.modelId = modelId;
  }

  /** Abort the active turn, then close all MCP connections (best-effort). */
  async dispose(): Promise<void> {
    this.abort?.abort();
    await Promise.all(this.mcpConnections.map((c) => c.close().catch(() => {})));
    this.mcpConnections = [];
  }
}
