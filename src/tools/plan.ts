import type { PlanEntry } from "@zed-industries/agent-client-protocol";
import type { Tool } from "../harness/tool.js";

type Priority = PlanEntry["priority"];
type Status = PlanEntry["status"];

const PRIORITIES: Priority[] = ["high", "medium", "low"];
const STATUSES: Status[] = ["pending", "in_progress", "completed"];

/**
 * Lets the model publish/update a task plan, surfaced to the client via the ACP
 * `plan` session update. The client replaces the whole plan on each call, so the
 * model must always send the complete list.
 */
export const updatePlanTool: Tool = {
  name: "update_plan",
  description:
    "发布或更新任务计划(TODO)，展示给用户。每次都要传完整的条目列表(会整体替换旧计划)。适合把复杂任务拆成步骤并随进度更新状态。",
  kind: "think",
  needsPermission: false,
  parameters: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description: "完整的计划条目列表",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "任务描述" },
            priority: { type: "string", enum: PRIORITIES, description: "优先级" },
            status: { type: "string", enum: STATUSES, description: "状态" },
          },
          required: ["content"],
        },
      },
    },
    required: ["entries"],
  },
  title: () => "更新计划",
  run: async (a, ctx) => {
    const rawEntries: unknown[] = Array.isArray(a.entries) ? a.entries : [];
    const entries: PlanEntry[] = rawEntries.map((e) => {
      const obj = (e ?? {}) as Record<string, unknown>;
      const priority = PRIORITIES.includes(obj.priority as Priority) ? (obj.priority as Priority) : "medium";
      const status = STATUSES.includes(obj.status as Status) ? (obj.status as Status) : "pending";
      return { content: String(obj.content ?? ""), priority, status };
    });

    await ctx.conn.sessionUpdate({
      sessionId: ctx.session.id,
      update: { sessionUpdate: "plan", entries },
    });

    return { output: `计划已更新（${entries.length} 项）` };
  },
};
