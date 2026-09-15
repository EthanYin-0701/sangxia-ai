import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import type { Tool } from "./tool.js";

// No coercion, defaults or removal of properties: validate exactly what was sent.
const validators = new WeakMap<Tool, ValidateFunction>();

export function validateToolArguments(tool: Tool, args: unknown): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "工具参数顶层必须是 JSON object";
  }
  let validate = validators.get(tool);
  if (!validate) {
    try {
      const dialect = tool.parameters.$schema;
      const options = { strict: false, validateFormats: true, logger: false as const };
      const ajv = typeof dialect === "string" && dialect.includes("2020-12")
        ? new Ajv2020(options)
        : typeof dialect === "string" && dialect.includes("2019-09")
          ? new Ajv2019(options) : new Ajv(options);
      addFormats.default(ajv);
      if (tool.parameters.$async) return "不支持异步工具 Schema";
      validate = ajv.compile(tool.parameters);
      validators.set(tool, validate);
    } catch {
      return "工具 Schema 无效或不受支持，拒绝执行";
    }
  }
  if (validate(args)) return null;
  // Exclude data/schema values (which can contain credentials).
  return "工具参数不符合 Schema: " + (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"}: ${e.keyword}`).join("; ");
}
