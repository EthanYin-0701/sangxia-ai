import type { Tool } from "../harness/tool.js";
import { bashTool } from "./bash.js";
import { fsTools } from "./fs-tools.js";
import { updatePlanTool } from "./plan.js";

/** Assemble the built-in tool set exposed to the LLM. */
export function buildTools(): Tool[] {
  return [...fsTools, bashTool, updatePlanTool];
}
