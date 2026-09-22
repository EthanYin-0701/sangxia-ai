/**
 * In-process ACP bridge (bridge.ts).
 *
 * Pairs a `SangxiaAgent` (agent side) with a `ClientSideConnection` (client
 * side) over two PassThrough byte streams, exactly like the stdio ACP server
 * in src/index.ts but entirely in memory — so the TUI drives the *same*
 * agent/protocol path Zed uses (§2 of plan/tui_support.md).
 *
 * Wiring direction (design §2 C6): A = client→agent, B = agent→client.
 *   agent side:  ndJsonStream(write→B, read←A)
 *   client side: ndJsonStream(write→A, read←B)
 * Swapping either produces a client talking to itself that silently hangs.
 */

import { PassThrough } from "node:stream";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@zed-industries/agent-client-protocol";
import { SangxiaAgent } from "../agent.js";
import type { Config } from "../config.js";

export interface BridgeEvents {
  /** Agent → client session notification (streaming, tool rows, plan…). */
  onSessionUpdate(n: SessionNotification): void;
  /**
   * Agent asks the user for permission. `respond` must eventually be called
   * exactly once (option selected, or `{ outcome: { outcome: "cancelled" } }`
   * when the turn is cancelled — ACP requires clients to settle pending
   * permission requests on cancel).
   */
  onPermissionRequest(req: RequestPermissionRequest, respond: (r: RequestPermissionResponse) => void): void;
}

/** Agent surface we need for lifecycle (shutdown closes MCP connections). */
export interface AgentHandle {
  shutdown(): Promise<void>;
}

export class TuiBridge {
  readonly #events: BridgeEvents;
  readonly #clientConn: ClientSideConnection;
  readonly #agentSide: AgentSideConnection;
  #agent: SangxiaAgent | null = null;
  /** Settles the currently-pending permission request (if any). */
  #pendingPermission: ((r: RequestPermissionResponse) => void) | null = null;
  #permissionRequest: RequestPermissionRequest | null = null;

  constructor(config: Config, events: BridgeEvents) {
    this.#events = events;

    // A = client→agent, B = agent→client
    const a = new PassThrough();
    const b = new PassThrough();
    const agentStream = ndJsonStream(Writable.toWeb(b), Readable.toWeb(a));
    const clientStream = ndJsonStream(Writable.toWeb(a), Readable.toWeb(b));

    this.#agentSide = new AgentSideConnection(
      (conn) => {
        this.#agent = new SangxiaAgent(conn, config);
        return this.#agent;
      },
      agentStream,
    );

    const client = this.#makeClient();
    this.#clientConn = new ClientSideConnection(() => client, clientStream);
  }

  #makeClient(): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.#events.onSessionUpdate(params);
      },
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.#pendingPermission = resolve;
          this.#permissionRequest = params;
          this.#events.onPermissionRequest(params, (r) => {
            this.#pendingPermission = null;
            this.#permissionRequest = null;
            resolve(r);
          });
        });
      },
    };
  }

  get agent(): AgentHandle {
    return this.#agent ?? { shutdown: async () => {} };
  }

  get pendingPermissionRequest(): RequestPermissionRequest | null {
    return this.#permissionRequest;
  }

  /** The UI answered a permission request with a specific option. */
  respondPermission(optionId: string): void {
    const resolve = this.#pendingPermission;
    // Clear state first so a stale getter can never return an answered request.
    this.#pendingPermission = null;
    this.#permissionRequest = null;
    resolve?.({ outcome: { outcome: "selected", optionId } });
  }

  /** The user cancelled the permission dialog without choosing. */
  dismissPermission(): void {
    const resolve = this.#pendingPermission;
    this.#pendingPermission = null;
    this.#permissionRequest = null;
    resolve?.({ outcome: { outcome: "cancelled" } });
  }

  /** Resolve any pending permission request as cancelled (turn cancelled). */
  cancelPendingPermission(): void {
    if (this.#pendingPermission) {
      this.#pendingPermission({ outcome: { outcome: "cancelled" } });
      this.#pendingPermission = null;
      this.#permissionRequest = null;
    }
  }

  async initialize(): Promise<InitializeResponse> {
    return this.#clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // TUI has no file/terminal capability to offer the agent: fs tools and
      // bash use the in-process Node fallbacks (design §3 B2). Bash output is
      // therefore buffered until the command exits — the tool row spinner
      // communicates liveness.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    return this.#clientConn.newSession({ cwd, mcpServers: [] });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    // Workaround: SDK 0.4.5's ClientSideConnection.setSessionModel sends
    // `session/set_mode` by mistake, so it can never switch a model. Go through
    // the ACP extension channel instead: the agent forwards `sangxia.set_model`
    // to its standard setSessionModel (same validation/persistence/errors).
    await this.#clientConn.extMethod("sangxia.set_model", { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: "confirm" | "auto"): Promise<void> {
    await this.#clientConn.setSessionMode({ sessionId, modeId });
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.#clientConn.prompt({ sessionId, prompt: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#clientConn.cancel({ sessionId });
  }

  async shutdown(): Promise<void> {
    await this.agent.shutdown();
  }
}

