import type { ProviderConfig } from "../config.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export function createProvider(cfg: ProviderConfig): LLMProvider {
  switch (cfg.type) {
    case "openai":
      return new OpenAIProvider(cfg);
    case "mock":
      return new MockProvider();
    default: {
      // Exhaustiveness guard — if a new provider type is added to the schema
      // without a case here, TypeScript flags it.
      const never: never = cfg.type;
      throw new Error(`未知的 provider 类型: ${String(never)}`);
    }
  }
}
