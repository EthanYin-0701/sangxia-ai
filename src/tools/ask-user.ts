import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Tool } from "../harness/tool.js";

/** Users think; the generic 300s tool deadline would cut a question off mid-answer. */
const ASK_TIMEOUT_MS = 30 * 60_000;

/** Option the user picks when none of the model's choices fits. */
const OTHER_OPTION_ID = "other";

/**
 * In-turn structured question to the user (SA-10).
 *
 * ACP has no dedicated "ask the user" request, but `session/request_permission`
 * already renders a titled list of options in every client (Zed's tool-call
 * card, the TUI dialog) and returns the chosen option — so each choice becomes
 * an `allow_once` option on the call's own tool row. Free text is not possible
 * through that request; the trailing "以上都不是" option tells the model to end
 * the turn and ask in prose instead.
 */
export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "在当前回合内向用户提一个选择题并等待回答（不结束回合）。适用于需求有歧义、存在多种合理方案、" +
    "或继续之前必须由用户拍板的情况。给出 2–6 个互斥选项；用户也可能选择「以上都不是」，" +
    "此时请结束回合并用文字询问。能通过读代码自己确认的事情不要问。",
  kind: "other",
  needsPermission: false,
  timeoutMs: ASK_TIMEOUT_MS,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 500, description: "要问用户的问题，完整、可独立理解" },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        description: "候选答案（互斥）",
        items: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 1, maxLength: 80, description: "选项文字" },
            description: { type: "string", maxLength: 200, description: "选项含义或后果（可选）" },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
  title: (a) => `提问：${String(a.question)}`,
  run: async (a, ctx) => {
    const question = String(a.question);
    const choices = (a.options as { label: string; description?: string }[]).map((o) => ({
      label: o.label.trim(),
      description: o.description?.trim() || undefined,
    }));
    const options: PermissionOption[] = [
      ...choices.map((c, i): PermissionOption => ({
        optionId: `choice_${i}`,
        name: c.description ? `${c.label}（${c.description}）` : c.label,
        kind: "allow_once",
      })),
      { optionId: OTHER_OPTION_ID, name: "以上都不是（我来补充说明）", kind: "reject_once" },
    ];

    ctx.signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(ctx.signal.reason ?? new Error("aborted"));
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    let res: RequestPermissionResponse;
    try {
      res = await Promise.race([
        aborted,
        ctx.conn.requestPermission({
          sessionId: ctx.session.id,
          toolCall: {
            toolCallId: ctx.toolCallId ?? `ask_user_${Date.now()}`,
            title: question,
            kind: "other",
            rawInput: { question, options: choices },
          },
          options,
        }),
      ]);
    } finally {
      if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
    }
    // A late answer after cancel/timeout must not be reported as the user's choice.
    ctx.signal.throwIfAborted();

    if (res.outcome.outcome === "cancelled") {
      return {
        output: "用户关闭了问题，没有作答。不要替用户做决定：请结束本回合，用文字说明需要用户确认的内容。",
        raw: { answered: false },
      };
    }
    const index = /^choice_(\d+)$/.exec(res.outcome.optionId)?.[1];
    const choice = index !== undefined ? choices[Number(index)] : undefined;
    if (!choice) {
      return {
        output: "用户认为以上选项都不合适，希望自己补充说明。请结束本回合，用文字询问用户的具体想法。",
        raw: { answered: false, optionId: res.outcome.optionId },
      };
    }
    return {
      output: `用户的回答：${choice.label}`,
      raw: { answered: true, answer: choice.label, index: Number(index) },
    };
  },
};
