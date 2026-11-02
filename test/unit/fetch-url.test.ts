import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { ToolContext } from "../../src/harness/tool.js";
import { validateToolArguments } from "../../src/harness/validation.js";
import { fetchUrlTool } from "../../src/tools/fetch-url.js";

function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

let main: { server: Server; origin: string };
let other: { server: Server; origin: string };
const seen: string[] = [];

before(async () => {
  other = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" }).end("other origin");
  });
  main = await listen((req, res) => {
    seen.push(req.url ?? "");
    switch (req.url) {
      case "/page":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><head><title>T</title></head><body><h1>Hi</h1><p>See <a href='/x'>x</a></p></body></html>");
        return;
      case "/json":
        res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
        return;
      case "/gbk":
        // "中文" in GBK
        res.writeHead(200, { "content-type": "text/plain; charset=gbk" }).end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
        return;
      case "/hop":
        res.writeHead(302, { location: "/page" }).end();
        return;
      case "/away":
        res.writeHead(301, { location: `${other.origin}/secret` }).end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" }).end();
        return;
      case "/bin":
        res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(10));
        return;
      case "/missing":
        res.writeHead(404, { "content-type": "text/plain" }).end("nope");
        return;
      case "/huge":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(3_000_000));
        return;
      case "/hang":
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        return; // never ends
      default:
        res.writeHead(500).end();
    }
  });
});

after(() => {
  main.server.closeAllConnections();
  main.server.close();
  other.server.close();
});

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { conn: {} as ToolContext["conn"], session: {} as ToolContext["session"], signal };
}

const run = (args: Record<string, unknown>, c = ctx()) => fetchUrlTool.run(args, c);

describe("fetch_url", () => {
  it("converts HTML to Markdown with the final URL and title", async () => {
    const r = await run({ url: `${main.origin}/page` });
    assert.equal(r.isError, undefined);
    assert.match(r.output, new RegExp(`^URL: ${main.origin}/page\\nHTTP 200\\nContent-Type: text/html; charset=utf-8\\nTitle: T\\n\\n# Hi\\n\\nSee \\[x\\]\\(${main.origin}/x\\)$`));
  });

  it("returns raw HTML when asked", async () => {
    const r = await run({ url: `${main.origin}/page`, raw: true });
    assert.match(r.output, /<h1>Hi<\/h1>/);
  });

  it("returns JSON as is and decodes the declared charset", async () => {
    assert.match((await run({ url: `${main.origin}/json` })).output, /\n\n\{"a":1\}$/);
    assert.match((await run({ url: `${main.origin}/gbk` })).output, /\n\n中文$/);
  });

  it("follows same-origin redirects", async () => {
    const r = await run({ url: `${main.origin}/hop` });
    assert.match(r.output, new RegExp(`^URL: ${main.origin}/page\\n`));
    assert.match(r.output, /# Hi/);
  });

  it("reports but does not follow a cross-origin redirect", async () => {
    const r = await run({ url: `${main.origin}/away` });
    assert.equal(r.isError, undefined);
    assert.match(r.output, new RegExp(`重定向到其他站点（HTTP 301）：${other.origin}/secret`));
    assert.doesNotMatch(r.output, /other origin/);
    assert.deepEqual(r.raw, { status: 301, redirect: `${other.origin}/secret` });
  });

  it("stops after too many redirects", async () => {
    const r = await run({ url: `${main.origin}/loop` });
    assert.equal(r.isError, true);
    assert.match(r.output, /重定向次数超过 5 次/);
  });

  it("rejects binary content and flags HTTP errors", async () => {
    const bin = await run({ url: `${main.origin}/bin` });
    assert.equal(bin.isError, true);
    assert.match(bin.output, /不支持的内容类型（image\/png）/);
    const missing = await run({ url: `${main.origin}/missing` });
    assert.equal(missing.isError, true);
    assert.match(missing.output, /^Error: HTTP 404\n[\s\S]*nope$/);
  });

  it("caps the download and the returned text", async () => {
    const r = await run({ url: `${main.origin}/huge`, max_chars: 1000 });
    assert.match(r.output, /只读取了开头部分/);
    assert.match(r.output, /输出过长，已省略中间 1999000 字符，共 2000000 字符/);
    assert.equal(r.raw?.bytes, 2_000_000);
    assert.equal(r.raw?.truncated, true);
  });

  it("aborts a hanging download when the signal fires", async () => {
    const controller = new AbortController();
    const pending = run({ url: `${main.origin}/hang` }, ctx(controller.signal));
    setTimeout(() => controller.abort(new Error("deadline")), 100);
    await assert.rejects(pending, /deadline/);
  });

  it("refuses non-http(s) URLs at schema and run time", async () => {
    assert.match(validateToolArguments(fetchUrlTool, { url: "file:///etc/passwd" })!, /\/url: pattern/);
    assert.match(validateToolArguments(fetchUrlTool, { url: "not a url" })!, /\/url/);
    assert.equal(validateToolArguments(fetchUrlTool, { url: "HTTPS://example.com/a" }), null);
    const r = await run({ url: "file:///etc/passwd" });
    assert.equal(r.isError, true);
  });

  it("scopes 'always allow' to the origin", async () => {
    const scope = await fetchUrlTool.permissionScope!({ url: "https://Docs.Example.com:443/a?q=1" }, {} as never);
    assert.deepEqual(scope, {
      lookup: ["fetch_url:origin:https://docs.example.com"],
      remember: "fetch_url:origin:https://docs.example.com",
      label: "https://docs.example.com",
    });
    const bad = await fetchUrlTool.permissionScope!({ url: "ftp://x" }, {} as never);
    assert.equal(bad.ignoreRemembered, true);
    assert.ok(bad.forceAsk);
  });

  it("needs permission", () => {
    assert.equal(fetchUrlTool.needsPermission, true);
  });
});
