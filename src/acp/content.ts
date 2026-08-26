import type { ContentBlock } from "@zed-industries/agent-client-protocol";

/**
 * Flatten ACP prompt content blocks into a single text string for the LLM.
 *
 * Text and embedded/linked resources are included; image/audio are noted but
 * their bytes are dropped (this agent doesn't advertise image/audio prompt caps).
 */
export function promptToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push(b.text);
        break;
      case "resource_link":
        parts.push(`[链接资源: ${b.name} <${b.uri}>]`);
        break;
      case "resource": {
        const r = b.resource as { uri?: string; text?: string };
        if (typeof r.text === "string") {
          parts.push(`[嵌入资源 ${r.uri ?? ""}]\n${r.text}`);
        } else {
          parts.push(`[嵌入资源 ${r.uri ?? ""}(二进制，已省略)]`);
        }
        break;
      }
      case "image":
        parts.push("[图片输入(当前不支持，已省略)]");
        break;
      case "audio":
        parts.push("[音频输入(当前不支持，已省略)]");
        break;
    }
  }
  return parts.join("\n\n");
}

/** Convenience constructor for a text content block. */
export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}
