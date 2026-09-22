# ACP Registry 本地准备与发布交接

本地准备版本：`sangxia-ai@0.6.16`，registry id：`sangxia-ai`，分支：`feature-acpreg`。

用户于 2026-09-22 选择先完成本地工作。GitHub 仓库由用户创建；当前没有 git remote，`npm whoami` 返回 `ENEEDAUTH`。本记录不代表 npm 已发布或 registry 已注册。

## 打包复核（D4）

已运行 `npm run prepublishOnly`（typecheck + build）和 `npm pack --dry-run --json`。

- `files` 白名单只包含 `dist/**`、`README.md`、`LICENSE`、`sangxia.config.example.json`，npm 自动包含 `package.json`。
- 当前共 84 个文件；不含源码、测试、技能、工作区配置、日志、review 或 IDE 文件。
- `dist/index.js` 第一行为 `#!/usr/bin/env node`。
- `package.json` 与 lockfile 版本一致：`0.6.16`。
- D3 的版本、license、keywords、白名单、prepublishOnly 已完成；`repository` / `homepage` / `bugs` 需在用户提供真实公开 GitHub URL 后回填，未写占位 URL。

复核命令：

```bash
npm run prepublishOnly
npm pack --dry-run --json
```

## Registry 材料（F2 / F3）

`registry/sangxia-ai/icon.svg` 是计划中的原始品牌图标转换稿，尺寸 16×16，前景 `currentColor`，已通过 registry 的 `validate_icon`。没有另做加粗或修改品牌图形。

收到真实 GitHub URL 后，在当前仓库执行：

```bash
node scripts/prepare-registry.mjs --repository https://github.com/OWNER/REPO --output /path/to/registry
```

命令从 package.json 读取实际版本，生成目标 registry checkout 的 `sangxia-ai/agent.json`，并复制图标。不手写 `icon` CDN 字段；`version` 与 npx 包版本保持一致。`license_url` 按计划使用 `main`，发布前确认公开仓库的 LICENSE 已在该分支。未提供真实 URL 时不生成含假地址的最终 manifest。

同时回填本仓库 package.json：

- `repository: { "type": "git", "url": "https://github.com/OWNER/REPO.git" }`
- `homepage: "https://github.com/OWNER/REPO#readme"`
- `bugs: { "url": "https://github.com/OWNER/REPO/issues" }`
