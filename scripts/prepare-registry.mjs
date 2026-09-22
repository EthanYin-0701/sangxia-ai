// Generate a registry entry only after the real public repository URL is known.
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: {
  repository: { type: "string" },
  output: { type: "string", default: join(root, "registry") },
} });
if (!values.repository) throw new Error("Usage: node scripts/prepare-registry.mjs --repository https://github.com/OWNER/REPO [--output REGISTRY_CHECKOUT]");
const url = new URL(values.repository);
if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) {
  throw new Error("repository must be an HTTPS GitHub owner/repository URL");
}
const repository = `${url.origin}${url.pathname.replace(/\/$/, "").replace(/\.git$/, "")}`;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(resolve(values.output), pkg.name);
mkdirSync(target, { recursive: true });
const manifest = {
  id: pkg.name,
  name: "Sangxia.ai",
  version: pkg.version,
  description: "Coding agent speaking ACP over stdio, with a built-in tool harness and JSON-configured OpenAI-compatible LLM backends",
  repository,
  website: `${repository}#readme`,
  authors: ["ethan"],
  license: pkg.license,
  license_url: `${repository}/blob/main/LICENSE`,
  distribution: { npx: { package: `${pkg.name}@${pkg.version}` } },
};
writeFileSync(join(target, "agent.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const icon = join(root, "registry", pkg.name, "icon.svg");
if (resolve(icon) !== join(target, "icon.svg")) copyFileSync(icon, join(target, "icon.svg"));
console.error(`Registry entry prepared: ${target}`);
