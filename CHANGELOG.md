# Changelog

## [0.7.0] - 2026-11-18

### ✨ Features
- **Reasoning Effort Selector**: 新增推理模型 effort 选择器（`none`/`low`/`high`/`max`）。已接入 ACP `configOptions`，支持按会话持久化，并在请求体中正确透传 `reasoning_effort`。`setup --preset deepseek` 自动配置 efforts。
- **自动化 npm 发布**: 新增 GitHub Actions 工作流 (`release.yml`)，打 tag (`v*`) push 后自动执行 `npm publish`（支持 OIDC provenance 与 pre-release dist-tag）。`INSTRUCTIONS.md` 补充了完整发布文档。

### 🔄 Refactors & Upgrades
- **ACP SDK 升级至 2.7.0 (SA-65)**: 从 `@agentclientprotocol/sdk@0.14.1` 全面迁移至 `2.7.0`。重写接入层路由（`agent()` + `AgentContext`），严格处理遗留方法兼容、错误日志与取消信号级联（`$/cancel_request` → `ctx.signal` → `session.abort`）。
- **依赖维护**: ESLint 升级至 `10.15.0`（修复 `minimatch` 安全漏洞）；批量刷新 `hono`/`jose`/`regexpp` 等传递依赖的安全补丁。

### 🐛 Fixes & Improvements
- **Hooks Smoke 测试修复**: 修正 hooks 冒烟测试中的断言逻辑，提升 CI 稳定性。
- **文档与仓库治理**: 更新 `AGENTS.md` 规则对齐最新实现；将本机自用技能目录 (`skills/youtrack-issue/`) 加入 `.gitignore`。

---
*注：本文件记录自上一版本 (v0.6.18) 以来的主要变更，随 v0.7.0 发布。*
