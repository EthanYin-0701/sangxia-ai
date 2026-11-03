import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ToolContext } from "../../src/harness/tool.js";
import { validateToolArguments } from "../../src/harness/validation.js";
import { askUserTool } from "../../src/tools/ask-user.js";

function ctx(
  answer: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  signal: AbortSignal = new AbortController().signal,
): { ctx: ToolContext; requests: RequestPermissionRequest[] } {
  const requests: RequestPermissionRequest[] = [];
  const conn = {
    requestPermission: (req: RequestPermissionRequest) => {
      requests.push(req);
      return answer(req);
    },
  } as unknown as ToolContext["conn"];
  return { ctx: { conn, session: { id: "s1" } as ToolContext["session"], signal, toolCallId: "call_7" }, requests };
}

const selected = (optionId: string) => async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId } });

const args = {
  question: "用哪种存储？",
  options: [{ label: "SQLite", description: "单文件，零运维" }, { label: "Postgres" }],
};

describe("ask_user", () => {
  it("asks through session/request_permission on its own tool call", async () => {
    const { ctx: c, requests } = ctx(selected("choice_1"));
    const r = await askUserTool.run(args, c);
    assert.equal(requests.length, 1);
    const req = requests[0]!;
    assert.equal(req.sessionId, "s1");
    assert.equal(req.toolCall.toolCallId, "call_7");
    assert.equal(req.toolCall.title, "用哪种存储？");
    assert.deepEqual(req.options, [
      { optionId: "choice_0", name: "SQLite（单文件，零运维）", kind: "allow_once" },
      { optionId: "choice_1", name: "Postgres", kind: "allow_once" },
      { optionId: "other", name: "以上都不是（我来补充说明）", kind: "reject_once" },
    ]);
    assert.equal(r.output, "用户的回答：Postgres");
    assert.deepEqual(r.raw, { answered: true, answer: "Postgres", index: 1 });
    assert.equal(r.isError, undefined);
  });

  it("tells the model to ask in prose when no option fits", async () => {
    const r = await askUserTool.run(args, ctx(selected("other")).ctx);
    assert.match(r.output, /以上选项都不合适.*结束本回合/);
    assert.equal(r.raw?.answered, false);
  });

  it("treats an unknown option id like 'none of these'", async () => {
    const r = await askUserTool.run(args, ctx(selected("choice_9")).ctx);
    assert.equal(r.raw?.answered, false);
  });

  it("reports a dismissed dialog without inventing an answer", async () => {
    const r = await askUserTool.run(args, ctx(async () => ({ outcome: { outcome: "cancelled" } })).ctx);
    assert.match(r.output, /没有作答/);
    assert.deepEqual(r.raw, { answered: false });
  });

  it("stops waiting when the turn is cancelled and ignores the late answer", async () => {
    const controller = new AbortController();
    let answer!: (r: RequestPermissionResponse) => void;
    const { ctx: c } = ctx(() => new Promise((resolve) => (answer = resolve)), controller.signal);
    const pending = askUserTool.run(args, c);
    controller.abort(new Error("cancelled by user"));
    await assert.rejects(pending, /cancelled by user/);
    answer({ outcome: { outcome: "selected", optionId: "choice_0" } });
  });

  it("does not ask at all on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const { ctx: c, requests } = ctx(selected("choice_0"), controller.signal);
    await assert.rejects(askUserTool.run(args, c), /gone/);
    assert.equal(requests.length, 0);
  });

  it("validates its arguments strictly", () => {
    assert.equal(validateToolArguments(askUserTool, args), null);
    assert.match(validateToolArguments(askUserTool, { question: "q", options: [{ label: "only" }] })!, /minItems/);
    assert.match(validateToolArguments(askUserTool, { ...args, timeout: 999_999 })!, /additionalProperties/);
    assert.match(validateToolArguments(askUserTool, { question: "", options: args.options })!, /minLength/);
  });

  it("outlives the generic tool deadline and needs no extra permission", () => {
    assert.ok((askUserTool.timeoutMs ?? 0) > 300_000);
    assert.equal(askUserTool.needsPermission, false);
  });
});
