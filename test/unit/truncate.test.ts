import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeadTailBuffer, truncateMiddle, truncationMarker } from "../../src/harness/truncate.js";

describe("truncateMiddle", () => {
  it("returns text within the limit unchanged", () => {
    assert.equal(truncateMiddle("abcdef", 6), "abcdef");
    assert.equal(truncateMiddle("", 10), "");
  });

  it("keeps head and tail and reports what was dropped", () => {
    const text = "H".repeat(50) + "M".repeat(100) + "T".repeat(50);
    const out = truncateMiddle(text, 100);
    assert.ok(out.startsWith("H".repeat(50)));
    assert.ok(out.endsWith("T".repeat(50)));
    assert.ok(!out.includes("M"));
    assert.ok(out.includes(truncationMarker(100, 200)));
  });

  it("puts the odd character of the budget into the tail", () => {
    const out = truncateMiddle("0123456789", 5);
    assert.equal(out, "01" + truncationMarker(5, 10) + "789");
  });

  it("never splits a surrogate pair at either cut", () => {
    const emoji = "😀"; // 2 UTF-16 code units
    const text = "a" + emoji + "b".repeat(20) + emoji + "c";
    for (let limit = 1; limit < text.length; limit++) {
      const out = truncateMiddle(text, limit);
      assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u, `limit=${limit}`);
    }
  });

  it("yields only the marker for a non-positive limit", () => {
    assert.equal(truncateMiddle("abc", 0), truncationMarker(3, 3));
  });
});

describe("createHeadTailBuffer", () => {
  it("matches the input while everything fits", () => {
    const buf = createHeadTailBuffer(10);
    buf.push("abc");
    buf.push("def");
    assert.equal(buf.text(), "abcdef");
    assert.equal(buf.dropped(), 0);
  });

  it("keeps the first and the most recent output across many chunks", () => {
    const buf = createHeadTailBuffer(10);
    for (const chunk of ["HEAD1", "xxxxxxxxxx", "yyyyyyyyyy", "TAIL2"]) buf.push(chunk);
    assert.equal(buf.dropped(), 20);
    assert.equal(buf.text(), "HEAD1" + truncationMarker(20, 30) + "TAIL2");
  });

  it("agrees with truncateMiddle on the kept characters", () => {
    const text = "0123456789".repeat(7);
    const buf = createHeadTailBuffer(20);
    for (let i = 0; i < text.length; i += 3) buf.push(text.slice(i, i + 3));
    assert.equal(buf.text(), truncateMiddle(text, 20));
  });
});
