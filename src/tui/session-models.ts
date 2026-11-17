import type { SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption } from "@agentclientprotocol/sdk";

export interface TuiModelInfo {
  modelId: string;
  name: string;
}

export interface TuiModelState {
  currentModelId: string;
  availableModels: TuiModelInfo[];
}

/**
 * The model selector of a `session/new` / `session/load` response, read from
 * the standard `configOptions` (`id === "model"`) — SA-65. The legacy `models`
 * field stays an outbound-only compatibility detail of `agent.ts`; the TUI
 * already switches through `session/set_config_option`, so it reads the same
 * place it writes. Returns null when the response carries no model selector.
 */
export function modelStateFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined,
): TuiModelState | null {
  const option = configOptions?.find((o) => o.id === "model");
  if (!option || option.type !== "select") return null;
  const entries = option.options as (SessionConfigSelectOption | SessionConfigSelectGroup)[];
  const flat = entries.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
  return {
    currentModelId: option.currentValue,
    availableModels: flat.map((o) => ({ modelId: o.value, name: o.name })),
  };
}
