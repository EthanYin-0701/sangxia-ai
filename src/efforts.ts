import type { ProviderConfig } from "./config.js";

/**
 * Reasoning-effort ("思考力度") selection.
 *
 * Some OpenAI-compatible backends accept a vendor knob for how much the model
 * should think before answering — DeepSeek exposes it as
 * `reasoning_effort: "none" | "low" | "high" | "max"` on
 * `/chat/completions` (default `high`; `none` disables thinking mode). Because
 * the field name and the accepted values are vendor-specific, Sangxia does not
 * hardcode them: a model becomes effort-selectable only when the config
 * declares the allowed `values` (see `provider.efforts` /
 * `provider.models[].efforts`). Until then the ACP `effort` selector is not
 * advertised at all, so nothing is sent that a backend could reject.
 */

/** Resolved effort selector for one model. */
export interface EffortChoices {
  /** Allowed values, in the order the client should show them. */
  values: string[];
  /** Value selected when the user never picked one. */
  default: string;
}

/**
 * Resolve the effort selector for `modelId`.
 *
 * Resolution order: `provider.models[].efforts` → `provider.efforts`; an
 * explicit `null` on a model means "this model has no selector" even when the
 * provider block declares one (a chat-only model next to a reasoning model).
 * The default falls back to `high` when it is an allowed value (DeepSeek's own
 * default), otherwise to the first listed value.
 */
export function modelEfforts(provider: ProviderConfig, modelId: string): EffortChoices | null {
  const model = provider.models?.find((entry) => entry.modelId === modelId);
  if (model && model.efforts === null) return null;
  const cfg = model?.efforts ?? provider.efforts;
  if (!cfg || cfg.values.length === 0) return null;
  const values = [...cfg.values];
  return {
    values,
    default: cfg.default ?? (values.includes("high") ? "high" : values[0]!),
  };
}

/** Whether `value` is one of the resolved choices. */
export function isAllowedEffort(choices: EffortChoices, value: string): boolean {
  return choices.values.includes(value);
}

/**
 * Display name/description for a value. Unknown values (a backend-specific
 * scale) fall back to the raw value so a custom scale still renders sanely.
 */
export function effortOption(value: string): { name: string; description?: string } {
  return EFFORT_LABELS[value] ?? { name: value };
}

const EFFORT_LABELS: Record<string, { name: string; description: string }> = {
  none: { name: "None", description: "不思考：最快最省（DeepSeek 会关闭思考模式）" },
  minimal: { name: "Minimal", description: "最少思考" },
  low: { name: "Low", description: "轻量思考：更快、更省 token" },
  medium: { name: "Medium", description: "中等思考量" },
  high: { name: "High", description: "深度思考（DeepSeek 默认）" },
  xhigh: { name: "Extra High", description: "更高思考量" },
  max: { name: "Max", description: "最深思考：最慢、最费 token" },
};
