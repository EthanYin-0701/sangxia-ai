import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calibrateEstimate, estimateText, estimateTokens, shouldCompact } from "../../src/harness/context.js";

describe("estimateText", () => {
  it("is 0 for empty / missing text", () => {
    assert.equal(estimateText(""), 0);
    assert.equal(estimateText(null), 0);
    assert.equal(estimateText(undefined), 0);
  });

  it("counts ~4 ASCII characters per token, rounded up", () => {
    assert.equal(estimateText("abcd"), 1);
    assert.equal(estimateText("abcde"), 2);
    assert.equal(estimateText("a".repeat(400)), 100);
  });

  it("weights non-ASCII (CJK, emoji) at 1.5 characters per token, per code point", () => {
    assert.equal(estimateText("你好吗"), 2);
    assert.equal(estimateText("😀😀😀"), 2); // 3 code points, not 6 UTF-16 units
    assert.equal(estimateText("ab你好"), Math.ceil(2 / 4 + 2 / 1.5));
  });
});

describe("estimateTokens", () => {
  it("adds per-message overhead, tool-call text and tool schemas", () => {
    const messages = [
      { role: "user" as const, content: "abcd" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "c1", name: "read", arguments: "abcdabcd" }],
      },
    ];
    // 2 × 4 overhead + 1 (content) + 1 ("read") + 2 (arguments)
    assert.equal(estimateTokens(messages), 12);
    const tools = [{ name: "read", description: "abcd", parameters: {} }];
    // + 1 (name) + 1 (description) + 1 ("{}")
    assert.equal(estimateTokens(messages, tools), 15);
  });

  it("is 0 for an empty prompt", () => {
    assert.equal(estimateTokens([]), 0);
  });
});

describe("calibrateEstimate", () => {
  it("passes the estimate through without a previous measurement", () => {
    assert.equal(calibrateEstimate(1000, null, null), 1000);
    assert.equal(calibrateEstimate(1000, 800, null), 1000);
    assert.equal(calibrateEstimate(1000, null, 900), 1000);
    assert.equal(calibrateEstimate(1000, 0, 900), 1000);
  });

  it("scales by the observed actual/estimate ratio", () => {
    assert.equal(calibrateEstimate(1000, 500, 600), 1200);
    assert.equal(calibrateEstimate(1000, 500, 400), 800);
  });

  it("clamps the ratio to [0.5, 2]", () => {
    assert.equal(calibrateEstimate(1000, 100, 10_000), 2000);
    assert.equal(calibrateEstimate(1000, 10_000, 100), 500);
  });
});

describe("shouldCompact", () => {
  it("triggers at and above the threshold", () => {
    assert.equal(shouldCompact(799, 1000, 0.8), false);
    assert.equal(shouldCompact(800, 1000, 0.8), true);
  });
});
