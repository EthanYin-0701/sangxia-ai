import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tool } from "../../src/harness/tool.js";
import { validateToolArguments } from "../../src/harness/validation.js";

function toolWith(parameters: Record<string, unknown>): Tool {
  return {
    name: "t",
    description: "",
    kind: "other",
    needsPermission: false,
    parameters,
    title: () => "t",
    run: async () => ({ output: "" }),
  };
}

const pathTool = toolWith({
  type: "object",
  properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
  required: ["path"],
  additionalProperties: false,
});

describe("validateToolArguments", () => {
  it("accepts arguments matching the schema", () => {
    assert.equal(validateToolArguments(pathTool, { path: "a.ts" }), null);
    assert.equal(validateToolArguments(pathTool, { path: "a.ts", limit: 3 }), null);
  });

  it("requires a top-level JSON object", () => {
    for (const args of [null, "x", 1, [], undefined]) {
      assert.equal(validateToolArguments(pathTool, args), "工具参数顶层必须是 JSON object");
    }
  });

  it("names the failing location and keyword", () => {
    assert.equal(validateToolArguments(pathTool, {}), "工具参数不符合 Schema: /: required");
    assert.equal(validateToolArguments(pathTool, { path: 1 }), "工具参数不符合 Schema: /path: type");
    assert.equal(validateToolArguments(pathTool, { path: "a", limit: 0 }), "工具参数不符合 Schema: /limit: minimum");
    assert.match(validateToolArguments(pathTool, { path: "a", extra: true })!, /additionalProperties/);
  });

  it("does not coerce types", () => {
    assert.match(validateToolArguments(pathTool, { path: "a", limit: "3" })!, /\/limit: type/);
  });

  it("never echoes argument values (they may contain secrets)", () => {
    const err = validateToolArguments(pathTool, { path: "a", extra: "sk-secret-value" })!;
    assert.doesNotMatch(err, /sk-secret-value/);
  });

  it("checks formats", () => {
    const uriTool = toolWith({ type: "object", properties: { url: { type: "string", format: "uri" } } });
    assert.equal(validateToolArguments(uriTool, { url: "https://example.com" }), null);
    assert.match(validateToolArguments(uriTool, { url: "not a uri" })!, /\/url: format/);
  });

  it("supports the 2020-12 dialect", () => {
    const tool = toolWith({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { items: { type: "array", prefixItems: [{ type: "string" }], items: false } },
    });
    assert.equal(validateToolArguments(tool, { items: ["a"] }), null);
    assert.match(validateToolArguments(tool, { items: ["a", "b"] })!, /\/items: items/);
  });

  it("rejects invalid and async schemas instead of executing", () => {
    assert.equal(validateToolArguments(toolWith({ type: "nope" }), {}), "工具 Schema 无效或不受支持，拒绝执行");
    assert.equal(validateToolArguments(toolWith({ $async: true, type: "object" }), {}), "不支持异步工具 Schema");
  });
});
