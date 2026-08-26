// Minimal offline MCP server over stdio, for smoke tests. Exposes one `echo`
// tool. Uses the already-installed @modelcontextprotocol/sdk — no network.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "mock", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the given text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "text to echo" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = String(req.params.arguments?.text ?? "");
  return { content: [{ type: "text", text: `echo: ${text}` }] };
});

await server.connect(new StdioServerTransport());
