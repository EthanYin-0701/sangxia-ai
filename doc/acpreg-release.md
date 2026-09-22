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

## 官方校验（C4，本地制品）

使用 [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry) 提交 `009da55c60aa50b5fea04df5b759e3bb9a2cbb21` 的原始脚本验证：

1. `client.run_auth_check` 启动本地 `dist/index.js`，空 cwd + 隔离 HOME：`terminal-setup(terminal)` 通过。
2. 在临时 registry clone 中生成 Sangxia 条目，运行 `SKIP_URL_VALIDATION=1 uv run --with jsonschema .github/workflows/build_registry.py`：包含 Sangxia 的完整 registry 构建通过，schema / 版本一致性 / icon 检查通过。因为真实仓库 URL 尚未提供，**仅这个临时测试 fixture** 使用 `https://github.com/example/sangxia-ai`，未将假 URL 写入项目发布元数据。
3. `npm pack` 生成 `sangxia-ai-0.6.16.tgz`；仅在临时 clone 的 manifest 中把 `distribution.npx.package` 改为 `file:/绝对路径/sangxia-ai-0.6.16.tgz`，运行 `python3 .github/workflows/verify_agents.py --auth-check --agent sangxia-ai`：**Passed 1 / Failed 0**，`Auth OK: terminal-setup(terminal)`。运行后恢复 manifest。

本地 tarball 必须用 `file:` npm spec；裸绝对路径会被 npx 当作可执行文件而失败。这些检查覆盖打包后安装、空 HOME 启动与认证声明，**不证明 npm 上的版本或真实 GitHub URL 已存在**。发布后必须用正式 `sangxia-ai@0.6.16` 再跑 C4 / E3。

## 本地回归

通过 `npm run typecheck`、`npm run build`，以及所有冒烟：`smoke`、`smoke:openai`、`smoke:mcp`、`smoke:skill`、`smoke:tui`、`smoke:hooks`（89 断言）、`smoke:reliability`（41 组）、`smoke:auth`（15 场景）和 `smoke:setup`。

另通过伪终端驱动交互 setup，验证 API key 不回显且正确保存；通过拦截 SDK fetch 验证未配置 baseURL 时不受 `OPENAI_BASE_URL` 影响，实际请求地址为官方 `/v1/chat/completions`，未访问真实 LLM。

## 外部待办

- **D3 / D5**：用户创建公开 GitHub 仓库并 push，回填真实 URL。已确认运行配置与日志未被 git 跟踪；保持原有 ignore 规则。
- **E1–E3**：npm 登录；核对 README 发布状态说明与最终包内容，执行 `npm publish --access public`；发布成功后打 `v0.6.16` tag，做已发布包沙箱握手。本次未登录、未发布、未打发布 tag。
- **F1 / F2 / F4**：fork registry，使用真实 URL 生成 manifest，跑官方验证并提交 PR；合并后核对 CDN。F3 图标已在本地准备并校验。
- **G1**：Zed 真机完成「未配置 → Terminal setup → 重连 → 新会话」。伪终端与协议测试不能替代这个客户端 UI 验收。
- **G2**：本地代码 TODO 已清理，工作规则与记忆记录本地完成情况；等发布和 registry 合并后才将注册整体标记为完成。
