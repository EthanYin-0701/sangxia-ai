import type { Tool } from "../harness/tool.js";
import { askUserTool } from "./ask-user.js";
import { bashTool } from "./bash.js";
import { fetchUrlTool } from "./fetch-url.js";
import { fsTools } from "./fs-tools.js";
import { updatePlanTool } from "./plan.js";

/** Assemble the built-in tool set exposed to the LLM. */
export function buildTools(): Tool[] {
  return [...fsTools, bashTool, fetchUrlTool, updatePlanTool, askUserTool];
}
