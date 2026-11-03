import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEntities, htmlToMarkdown } from "../../src/tools/html-to-markdown.js";

const md = (html: string, base?: string) => htmlToMarkdown(html, base).markdown;

describe("htmlToMarkdown", () => {
  it("extracts the title and drops head, scripts, styles and comments", () => {
    const out = htmlToMarkdown(
      `<!DOCTYPE html><html><head><title>Docs &amp; API</title><style>p{color:red}</style>
       <script>alert("x<p>")</script></head><body><!-- hidden --><p>Hello</p><noscript>no js</noscript></body></html>`,
    );
    assert.equal(out.title, "Docs & API");
    assert.equal(out.markdown, "Hello");
  });

  it("renders headings and paragraphs with collapsed whitespace", () => {
    assert.equal(md("<h1>Title</h1><p>one\n   two</p><h3> Sub </h3><div>three</div>"), "# Title\n\none two\n\n### Sub\n\nthree");
  });

  it("renders links (resolved against the base URL) and images", () => {
    assert.equal(
      md(`<p>See <a href="/guide?x=1">the guide</a> and <a href="https://e.com/">https://e.com/</a>.</p>`, "https://docs.example.com/a/b"),
      "See [the guide](https://docs.example.com/guide?x=1) and <https://e.com/>.",
    );
    assert.equal(md(`<img src="logo.png" alt="Logo">`, "https://x.org/p/"), "![Logo](https://x.org/p/logo.png)");
  });

  it("drops javascript: and fragment-only links but keeps their text", () => {
    assert.equal(md(`<a href="javascript:void(0)">Click</a> <a href="#top">Top</a>`), "Click Top");
  });

  it("honors <base href>", () => {
    assert.equal(
      md(`<head><base href="https://cdn.example.com/v2/"></head><a href="api.html">API</a>`, "https://example.com/"),
      "[API](https://cdn.example.com/v2/api.html)",
    );
  });

  it("renders nested and ordered lists", () => {
    assert.equal(
      md("<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul><ol start=3><li>x<li>y</ol>"),
      "- a\n- b\n\n  - b1\n\n3. x\n4. y",
    );
  });

  it("keeps <pre> content verbatim in a fence and marks inline code", () => {
    assert.equal(
      md("<p>Run <code>npm  test</code>:</p><pre><code>if (a &lt; b) {\n    go();\n}\n\n\n\nend</code></pre>"),
      "Run `npm test`:\n\n```\nif (a < b) {\n    go();\n}\n\n\n\nend\n```",
    );
  });

  it("renders emphasis, strike-through, line breaks and rules", () => {
    assert.equal(md("<p><strong>bold</strong> <em>it</em> <del>old</del><br>next</p><hr><p>after</p>"), "**bold** *it* ~~old~~  \nnext\n\n---\n\nafter");
  });

  it("prefixes blockquotes", () => {
    assert.equal(md("<blockquote><p>one</p><p>two</p></blockquote>"), "> one\n>\n> two");
  });

  it("renders tables, including unclosed cells and escaped pipes", () => {
    assert.equal(
      md("<table><tr><th>Name</th><th>Value</th></tr><tr><td>a|b<td>1</tr><tr><td>c</td></tr></table>"),
      "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c |  |",
    );
  });

  it("tolerates malformed markup", () => {
    assert.equal(md("<p>a <b>b</p> <a href='https://x.y'>c"), "a **b**\n\n[c](https://x.y/)");
    assert.equal(md("1 < 2 and </span> stray"), "1 < 2 and stray");
  });

  it("does not let '>' inside attribute values end the tag", () => {
    assert.equal(md(`<a title="a > b" href="https://x.y/">link</a>`), "[link](https://x.y/)");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones", () => {
    assert.equal(decodeEntities("&lt;a&gt; &amp;amp; &#39;&#x4e2d;&#20013; &mdash; &bogus; &#0;"), "<a> &amp; '中中 — &bogus; &#0;");
  });
});

describe("htmlToMarkdown inline markers", () => {
  it("closes unclosed emphasis at the block boundary and ignores stray closers", () => {
    assert.equal(md("<p><b>bold<i>both</p><p>plain</b></i> text</p>"), "**bold*both***\n\nplain text");
  });
});

describe("htmlToMarkdown performance", () => {
  // Reading the accumulated buffer back (`/\s$/.test(out)`) flattened the
  // string rope on every text node, making conversion quadratic: ~1.1 MB of
  // tag-dense HTML took ~15 s and blocked the event loop.
  it("converts ~1 MB of tag-dense HTML in linear time", () => {
    const n = 30_000;
    const html = `<body>${"<div><a href='/x'>w</a> <span>v</span> <b>x</b></div>".repeat(n)}</body>`;
    const start = performance.now();
    const { markdown } = htmlToMarkdown(html, "https://e.com/");
    const elapsed = performance.now() - start;
    assert.equal(markdown, Array(n).fill("[w](https://e.com/x) v **x**").join("\n\n"));
    assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
  });
});
