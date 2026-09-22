import { createServer } from "node:http";

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- Fake OpenAI-compatible /chat/completions server (streaming) ---------------
export function createFakeOpenAI({ modelsStatus = 200, chatStatus = 200, onRequest = () => {} } = {}) {
return createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    onRequest(req, payload);
    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(modelsStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404); res.end(); return;
    }
    if (chatStatus !== 200 || !payload.stream) {
      res.writeHead(chatStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
      return;
    }
    const isFollowUp = (payload.messages ?? []).some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });

    if (!isFollowUp) {
      // First call: emit some text, then a tool_call whose JSON arguments are
      // split across two chunks (exercises the provider's accumulation logic).
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "好，" } }] }));
      res.write(sse({ choices: [{ index: 0, delta: { content: "我来创建文件。" } }] }));
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"from-openai.txt",' } },
                ],
              },
            },
          ],
        }),
      );
      res.write(
        sse({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"via openai path\\n"}' } }] } },
          ],
        }),
      );
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    } else {
      // Follow-up (after the tool result): just answer and stop.
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "文件已创建完成。" } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

}
