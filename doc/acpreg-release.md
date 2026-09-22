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
