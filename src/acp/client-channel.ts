import type {
  CreateTerminalRequest,
  KillTerminalCommandResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

/** The slice of a client terminal handle that `bash` uses. */
export interface ClientTerminal {
  readonly id: string;
  currentOutput(): Promise<TerminalOutputResponse>;
  waitForExit(): Promise<WaitForTerminalExitResponse>;
  kill(): Promise<KillTerminalCommandResponse>;
  release(): Promise<ReleaseTerminalResponse | void>;
}

/**
 * Agent → client requests the harness, tools and agent actually make (SA-65).
 *
 * Only plain ACP schema types appear here, never the SDK's connection classes,
 * so the transport (today `AgentSideConnection`, which satisfies this
 * structurally) can change without touching the harness, tools or unit tests.
 */
export interface ClientChannel {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  createTerminal(params: CreateTerminalRequest): Promise<ClientTerminal>;
}
