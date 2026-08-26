import type { McpServer } from "@zed-industries/agent-client-protocol";
import { ToolRegistry } from "./harness/tool.js";
import type { ChatMessage } from "./llm/types.js";
import type { McpConnection } from "./mcp/client.js";
import type { Skill } from "./skills/index.js";

/** Which file/terminal operations the connected client supports. */
export interface ClientCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
}

/** A remembered permission decision for a tool (from "always" choices). */
export type PermissionDecision = "allow" | "reject";

/** Per-conversation state held by the agent. */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly mcpServers: McpServer[];
  readonly clientCaps: ClientCapabilities;

  /** Full LLM conversation history (system + user + assistant + tool). */
  messages: ChatMessage[] = [];

  /** Tool name → remembered allow/reject (set by "allow always" / "reject always"). */
  readonly permissions = new Map<string, PermissionDecision>();

  /** Set while a prompt turn is running; used to cancel. */
  abort: AbortController | null = null;

  /** Tools for this session = built-ins + `use_skill` + MCP tools. Populated in `newSession`. */
  tools: ToolRegistry = new ToolRegistry([]);

  /** Live MCP connections opened for this session; closed by {@link dispose}. */
  mcpConnections: McpConnection[] = [];

  /** Skills discovered for this session's cwd (name + description + SKILL.md path). */
  skills: Skill[] = [];

  /** Prevent repeatedly asking about project initialization in one session. */
  initializationChecked = false;

  constructor(id: string, cwd: string, mcpServers: McpServer[], clientCaps: ClientCapabilities) {
    this.id = id;
    this.cwd = cwd;
    this.mcpServers = mcpServers;
    this.clientCaps = clientCaps;
  }

  /** Close all MCP connections held by this session (best-effort). */
  async dispose(): Promise<void> {
    await Promise.all(this.mcpConnections.map((c) => c.close().catch(() => {})));
    this.mcpConnections = [];
  }
}
