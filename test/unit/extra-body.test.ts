import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig, type ProviderConfig } from "../../src/config.js";
import { mergeBody, OpenAIProvider } from "../../src/llm/openai.js";

let server: Server;
let baseURL: string;
const bodies: Record<string, unknown>[] = [];
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-extra-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Parse a provider block through the real config loader (zod + defaults). */
function providerConfig(provider: Record<string, unknown>): ProviderConfig {
  const path = join(dir, `cfg-${bodies.length}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ provider: { type: "openai", apiKey: "k", baseURL, ...provider } }));
  return loadConfig(["--config", path]).provider;
}

async function send(cfg: ProviderConfig): Promise<Record<string, unknown>> {
  const before = bodies.length;
  const provider = new OpenAIProvider(cfg);
  const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];
  for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "u" }], tools, signal: new AbortController().signal })) {
    // drain
  }
  assert.equal(bodies.length, before + 1);
  return bodies.at(-1)!;
}

describe("provider.extraBody (SA-8)", () => {
  it("sends vendor parameters such as reasoning_effort and top_p", async () => {
    const body = await send(providerConfig({ model: "deepseek-reasoner", extraBody: { reasoning_effort: "high", top_p: 0.9, thinking: { type: "enabled" } } }));
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.thinking, { type: "enabled" });
    // Harness-owned fields are untouched.
    assert.equal(body.model, "deepseek-reasoner");
    assert.equal(body.stream, true);
    assert.equal((body.tools as unknown[]).length, 1);
  });

  it("deep-merges nested objects and lets the per-model block win", async () => {
    const cfg = providerConfig({
      model: "a",
      models: [{ modelId: "a", name: "A", extraBody: { top_p: 0.5, metadata: { tier: "model" } } }],
      extraBody: { top_p: 0.9, temperature: 0.7, stream_options: { foo: 1 }, metadata: { app: "sangxia", tier: "provider" } },
    });
    const body = await send(cfg);
    assert.equal(body.top_p, 0.5, "per-model value overrides provider-level");
    assert.equal(body.temperature, 0.7, "extraBody can tune Sangxia's own defaults");
    assert.deepEqual(body.stream_options, { include_usage: true, foo: 1 }, "nested objects merge instead of replacing");
    assert.deepEqual(body.metadata, { app: "sangxia", tier: "model" });
  });

  it("omits nothing extra when extraBody is unset", async () => {
    const body = await send(providerConfig({ model: "m" }));
    assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "stream", "stream_options", "temperature", "tool_choice", "tools"]);
  });

  it("rejects fields the harness owns at config load time", () => {
    for (const key of ["model", "messages", "stream", "tools"]) {
      assert.throws(() => providerConfig({ model: "m", extraBody: { [key]: 1 } }), /extraBody 不能覆盖/, key);
    }
    assert.throws(
      () => providerConfig({ model: "a", models: [{ modelId: "a", name: "A", extraBody: { messages: [] } }] }),
      /extraBody 不能覆盖/,
    );
  });

  it("mergeBody copies values and ignores prototype keys", () => {
    const extra = JSON.parse('{"a":{"b":[1]},"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const out = mergeBody({ a: { c: 2 } }, extra);
    assert.deepEqual(out, { a: { c: 2, b: [1] } });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    (out.a as { b: number[] }).b.push(2);
    assert.deepEqual((extra.a as { b: number[] }).b, [1], "config object is not aliased into the request");
  });
});
