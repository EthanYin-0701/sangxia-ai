import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { APIError } from "openai";
import { loadConfig, type ProviderConfig } from "../../src/config.js";
import { OpenAIProvider } from "../../src/llm/openai.js";
import { logger } from "../../src/logger.js";
import { ProviderError, type StreamEvent } from "../../src/llm/types.js";

/**
 * Error mapping and retry regression tests for the OpenAI-compatible provider.
 *
 * These exercise the SDK surface that `npm run typecheck` cannot protect and
 * `smoke:openai` (happy path only) never reaches: the `APIError` subclasses
 * behind `isRetryable()`, `APIError.status`/`.headers` behind
 * `toProviderError()`/`parseRetryAfter()`, and the retry loop itself. Written
 * while upgrading `openai` 6.x → 7.x (SA-71) — a major-version bump that
 * renames or reshapes those classes would pass typecheck and smoke, and only
 * fail here.
 */

let server: Server;
let baseURL: string;
let dir: string;
let attempts = 0;
/** Per-test response script; `attempt` is 1-based. */
let respond: (res: ServerResponse, attempt: number) => void;

function json(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { message, type: "test_error" } }));
}

function stream(res: ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

before(async () => {
  // Keep the retry/timeout logs out of the test output.
  logger.configure({ stderr: false, level: "error" });
  dir = mkdtempSync(join(tmpdir(), "sangxia-openai-errors-"));
  // Isolate from the developer's own ~/.config/sangxia/config.json, which is
  // always layered in as the base config (see extra-body.test.ts).
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => respond(res, ++attempts));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  attempts = 0;
});

/** Build a provider through the real config loader (zod + defaults). */
function provider(overrides: Record<string, unknown> = {}): OpenAIProvider {
  const path = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ provider: { type: "openai", apiKey: "k", baseURL, model: "m", ...overrides } }));
  return new OpenAIProvider(loadConfig(["--config", path]).provider as ProviderConfig);
}

async function drain(p: OpenAIProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of p.streamChat({ messages: [{ role: "user", content: "u" }], tools: [], signal: new AbortController().signal })) {
    events.push(ev);
  }
  return events;
}

async function failure(p: OpenAIProvider): Promise<unknown> {
  try {
    await drain(p);
  } catch (e) {
    return e;
  }
  return assert.fail("expected streamChat to throw");
}

describe("OpenAI provider error mapping (SA-71)", () => {
  it("maps 401 to an actionable ProviderError and does not retry it", async () => {
    respond = (res) => json(res, 401, "Authentication Fails");
    const error = await failure(provider({ streamRetries: 2, streamRetryBaseDelayMs: 1 }));
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    assert.match(error.userMessage, /API Key 无效或未授权/);
    // The SDK's own subclass (AuthenticationError in 7.x) must still extend
    // APIError, or isRetryable()/parseRetryAfter() silently stop working.
    assert.ok(error.cause instanceof APIError);
    assert.equal((error.cause as APIError).status, 401);
    assert.equal(attempts, 1, "401 is not retryable");
  });

  it("maps 402 to the insufficient-balance message", async () => {
    respond = (res) => json(res, 402, "Insufficient Balance");
    const error = await failure(provider({ streamRetries: 0 }));
    assert.ok(error instanceof ProviderError);
    assert.match(error.userMessage, /余额不足/);
    assert.equal((error.cause as APIError).status, 402);
  });

  it("explains a 400 caused by missing reasoning_content", async () => {
    respond = (res) => json(res, 400, "messages: the last message must contain reasoning_content");
    const error = await failure(provider({ streamRetries: 0 }));
    assert.ok(error instanceof ProviderError);
    assert.match(error.userMessage, /reasoning_content/);
  });

  it("passes an unmapped status through unchanged instead of inventing advice", async () => {
    respond = (res) => json(res, 404, "model not found");
    const error = await failure(provider({ streamRetries: 2, streamRetryBaseDelayMs: 1 }));
    assert.ok(!(error instanceof ProviderError), "404 has no better explanation than the SDK's own");
    assert.ok(error instanceof APIError);
    assert.equal(error.status, 404);
    assert.equal(attempts, 1, "404 is not retryable");
  });

  it("retries a 429 streamRetries times before giving up", async () => {
    respond = (res) => json(res, 429, "rate limit reached");
    const error = await failure(provider({ streamRetries: 2, streamRetryBaseDelayMs: 1 }));
    assert.ok(error instanceof ProviderError);
    assert.match(error.userMessage, /速率上限/);
    assert.equal(attempts, 3, "1 initial attempt + 2 retries");
  });

  it("recovers after a 429 and honors Retry-After over the backoff schedule", async () => {
    respond = (res, attempt) => (attempt === 1 ? json(res, 429, "rate limit reached", { "retry-after": "0" }) : stream(res, "hi"));
    // Retry-After: 0 must win over this deliberately huge base delay.
    const started = Date.now();
    const events = await drain(provider({ streamRetries: 2, streamRetryBaseDelayMs: 5000 }));
    const elapsed = Date.now() - started;
    assert.equal(attempts, 2);
    assert.deepEqual(
      events.map((e) => e.type),
      ["text-delta", "done"],
    );
    assert.ok(elapsed < 2000, `Retry-After was ignored (waited ${elapsed}ms)`);
  });
});
