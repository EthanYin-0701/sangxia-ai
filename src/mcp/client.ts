import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@zed-industries/agent-client-protocol";
import type { Tool } from "../harness/tool.js";
import { logger } from "../logger.js";

/**
 * A live connection to one MCP server, plus its tools already adapted to the
 * harness {@link Tool} contract so `runTurn` can dispatch them like any built-in.
 */
export interface McpConnection {
  serverName: string;
  client: Client;
  tools: Tool[];
  close(): Promise<void>;
}

/** ACP passes env/headers as {name,value}[]; the SDK wants a plain record. */
function toRecord(pairs: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) out[p.name] = p.value;
  return out;
}

/** Tool names must be `[a-zA-Z0-9_-]`; server names are free-form, so sanitize. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Connect to a single MCP server (stdio / streamable-http / sse — the three ACP
 * transports), list its tools, and wrap each as a harness {@link Tool}.
 *
 * The stdio variant of `McpServer` has no `type` discriminant, so we narrow on
 * `"command" in server` first, then on `type` for the network transports.
 */
export async function connectMcpServer(server: McpServer, timeoutMs: number): Promise<McpConnection> {
  let transport: Transport;
  if ("command" in server) {
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      // Merge over the SDK's safe default env so PATH etc. are inherited.
      env: { ...getDefaultEnvironment(), ...toRecord(server.env) },
    });
  } else if (server.type === "sse") {
    transport = new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: toRecord(server.headers) },
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: toRecord(server.headers) },
    });
  }

  const client = new Client({ name: "zhente", version: "0.1.0" });
  await client.connect(transport, { timeout: timeoutMs });

  const { tools: mcpTools } = await client.listTools(undefined, { timeout: timeoutMs });
  const tools = mcpTools.map((t) => wrapMcpTool(server.name, client, t));
  logger.info(
    `MCP '${server.name}' 已连接，工具 ${tools.length} 个: ${mcpTools.map((t) => t.name).join(", ") || "(无)"}`,
  );

  return {
    serverName: server.name,
    client,
    tools,
    close: () => client.close(),
  };
}

/** A single tool as returned by MCP `tools/list`. */
type McpToolInfo = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** Adapt one MCP tool into the harness {@link Tool} contract. */
function wrapMcpTool(serverName: string, client: Client, mcpTool: McpToolInfo): Tool {
  const name = `mcp__${sanitize(serverName)}__${mcpTool.name}`;
  return {
    name,
    description: mcpTool.description ?? `MCP 工具 ${mcpTool.name}（来自 ${serverName}）`,
    kind: "other",
    // External side effects are unknown, so gate every MCP tool by default.
    needsPermission: true,
    parameters: mcpTool.inputSchema,
    title: () => `${serverName}: ${mcpTool.name}`,
    run: async (args, ctx) => {
      const res = await client.callTool(
        { name: mcpTool.name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal: ctx.signal },
      );
      const content = Array.isArray(res.content) ? res.content : [];
      const output = content
        .map((c) => (c.type === "text" ? c.text : `[${c.type} 内容]`))
        .join("\n");
      return { output: output || "(无输出)", isError: Boolean(res.isError) };
    },
  };
}
