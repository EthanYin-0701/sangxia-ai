import { createRequire } from "node:module";

/** Works from both src/ and the published dist/ without changing rootDir. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
export const AGENT_INFO = { name: "sangxia", title: "Sangxia.ai", version: VERSION };
