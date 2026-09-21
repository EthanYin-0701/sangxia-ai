---
name: deepseek-usage
description: >-
  Check the DeepSeek account credit balance and inspect token usage. Route
  "balance" hits the official GET /user/balance endpoint with the API key from
  the environment or the zhente config (the key itself is never printed);
  route "usage" aggregates local prompt / completion / reasoning token counts
  per day and per model from ZhenTe log files ($ZHENTE_LOG_DIR,
  $ZHENTE_LOG_FILE, ~/.config/zhente/logs) or, as a fallback, from the newest
  JetBrains IDE logs — DeepSeek publishes no account-level usage API. Use when
  the user asks about DeepSeek credit, balance, remaining quota, top-up,
  spending, cost, or token usage.
---

# deepseek-usage

查 DeepSeek 账户 **余额（credit）** 和 **token 用量（usage）**，两个子命令，零依赖（Node ≥ 20）。

| 子命令 | 数据来源 | 说明 |
| --- | --- | --- |
| `balance` | 官方 `GET <base>/user/balance` | 真实账户余额（唯一公开的账户级接口） |
| `usage` | 本地日志聚合 | prompt / completion / reasoning token，按日期与模型汇总 |

**官方没有任何账户级 usage API**：DeepSeek 只公开 `/user/balance`、`/models` 和 `/chat/completions`。
`completion` 的 `usage` 字段只描述**单次请求**，所以"账户累计用了多少"只能靠本地日志聚合，
或者在网页 https://platform.deepseek.com 的用量页核对。回答用户时不要暗示存在官方用量接口。

## 步骤 1：定位脚本

技能可能装在项目里（`<cwd>/skills`、`<cwd>/.claude/skills`）或全局（`~/.config/zhente/skills`），
所以先按候选路径定位，**不要假设脚本在 cwd 下**：

```bash
for cand in \
  "skills/deepseek-usage/scripts/deepseek-usage.mjs" \
  ".claude/skills/deepseek-usage/scripts/deepseek-usage.mjs" \
  "${ZHENTE_CONFIG:+$(dirname "$ZHENTE_CONFIG")/skills/deepseek-usage/scripts/deepseek-usage.mjs}" \
  "$HOME/.config/zhente/skills/deepseek-usage/scripts/deepseek-usage.mjs"; do
  [ -n "$cand" ] && [ -f "$cand" ] && SCRIPT="$cand" && break
done
[ -f "${SCRIPT:-}" ] || { echo "找不到 deepseek-usage.mjs（技能未安装或被移动）"; exit 1; }
echo "SCRIPT=$SCRIPT"
node "$SCRIPT" --help | head -5
```

拿到绝对/相对路径后，后续命令都用 `node "$SCRIPT"`。用绝对路径最省事：脚本本身与 cwd 无关，
只有它的 **日志发现** 和 **配置发现** 会受 cwd 影响（见下文"跨项目使用"）。

## 跨项目使用（重要）

本技能是**纯本地技能**（不依赖 MCP），所以在任何 cwd 下的 ZhenTe session 都能用，包括 TUI。
但有两件事按 cwd 解析，换项目后行为会变：

1. **配置发现**会先看当前项目：`--config` → `$ZHENTE_CONFIG` → `<cwd>/zhente.config.json` → `~/.config/zhente/config.json`。
   别的项目的 `provider.baseURL` / `apiKey` 可能指向**别的厂商**，此时余额查询会报 404/401
   （脚本会打一行 `warning: base URL … 看起来不是 DeepSeek 端点`）。
   跨项目时若需临时指定端点，可显式指定 base URL（API key 统一从已导出的环境变量或宿主环境获取，**绝不直接在命令里键入明文 key**）：

   ```bash
   node "$SCRIPT" balance --base-url https://api.deepseek.com
   # 或 DEEPSEEK_BASE_URL=https://api.deepseek.com node "$SCRIPT" balance
   ```

   （`$DEEPSEEK_API_KEY` / `$DEEPSEEK_BASE_URL` 优先级高于配置文件，且不会把 key 留在历史记录中。）

2. **日志发现**默认找 `$ZHENTE_LOG_DIR` / `$ZHENTE_LOG_FILE` / `~/.config/zhente/logs`，找不到就兜底
   扫 JetBrains IDE 日志。如果那个项目用 `--log` 或别的日志位置，就显式传：

   ```bash
   node "$SCRIPT" usage --log <那个项目的日志文件或目录>
   ```

3. 查到的 `balance` 是**整个 DeepSeek 账户**的，与 cwd 无关（所有项目共用一个账户）；
   而 `usage` 只统计能找到的日志，**别的项目/别的机器上跑的请求不在其中**。

## 步骤 2a：balance — 查余额

```bash
node "$SCRIPT" balance            # 人类可读
node "$SCRIPT" balance --json     # JSON：isAvailable + balances[] + baseUrlSource
```

凭证解析顺序（脚本自动处理，**只打印来源、绝不打印 key**）：

1. `--api-key <key>`
2. `$DEEPSEEK_API_KEY`
3. `$OPENAI_API_KEY`（本项目 zhente.config.json 用 `${OPENAI_API_KEY}` 指向 DeepSeek，所以通常命中这个）
4. 配置文件 `provider.apiKey`（`--config` → `$ZHENTE_CONFIG` → `./zhente.config.json` → `~/.config/zhente/config.json`，支持 `${ENV_VAR}` 插值）

base URL 同理：`--base-url` → `$DEEPSEEK_BASE_URL` → 配置 `provider.baseURL` → `https://api.deepseek.com`；
空串一律视作"未设置"（回落到下一级），非 `http(s)` 绝对地址会直接报错。
结尾带 `/v1` 时脚本会自动回退到不带 `/v1` 的端点。

输出形如：

```
DeepSeek 账户余额
  端点: https://api.deepseek.com/user/balance（base URL 来自 默认值）
  凭证来源: $OPENAI_API_KEY
  可用状态: 可用 (is_available=true)

  CNY
    总余额       48.05
    赠送余额     0.00
    充值余额     48.05
```

解读：`总余额 = 赠送余额 + 充值余额`；`is_available=false` 表示余额耗尽、请求会被拒。
余额只反映**剩余额度**，不等于花费；想知道花了多少就对比两次 `balance`，或去网页用量页。

## 步骤 2b：usage — 本地 token 用量

```bash
node "$SCRIPT" usage                              # 全部日志
node "$SCRIPT" usage --since 2026-09-01            # 只看某日期起（含）
node "$SCRIPT" usage --since 2026-09-14 --until 2026-09-15
node "$SCRIPT" usage --json                        # 机器可读
```

日志来源解析顺序：

1. `--log <file|dir>`（可重复；目录取其中的 `*.log`，不递归）
2. `$ZHENTE_LOG_DIR`（目录）、`$ZHENTE_LOG_FILE`（单文件）
3. `~/.config/zhente/logs`
4. 都为空时兜底：JetBrains 日志目录（macOS `~/Library/Logs/JetBrains`、Linux `~/.cache/JetBrains`、Windows `%LOCALAPPDATA%/JetBrains`）下**最近修改的 15 个** `*.log`（IDE 会把 agent 的 stderr 记进去）

统计口径：只认 `LLM request end … usage={…}` 行，按 `(行内 agent 时间戳 + 整行内容)` 去重
（同一行同时出现在 `zhente-acp.log` 和 IDE 日志里只算一次），日期取 agent 自己写的时间戳。

```
本地 token 用量
  数据源: ZhenTe 日志
  文件: /path/to/zhente-acp.log
  扫描文件: 1   命中 "LLM request end": 2,625   含 usage: 387   无 usage 记录: 28
  时间范围: 2026-09-14 .. 2026-09-20

按日期
  日期          请求      prompt        completion    reasoning   total
  2026-09-15  371     30,228,876    320,961       182,774     30,549,837
...
合计
  total tokens:      32,122,734
```

### 为什么有很多"无 usage 记录"的请求

只有 `provider.streamIncludeUsage=true`（当前版本默认 `true`）的请求才带 usage。老日志、显式设为 `false` 的配置，或中途失败/被取消的请求没有 usage chunk。要确认或开启，检查 `zhente.config.json` 中的 `provider.streamIncludeUsage`。

## 输出纪律

- 把脚本输出转述给用户即可，**不要自己改动数字或重新估算**。
- 只在脚本没有覆盖到的语义上补充解释（比如"余额≠花费"、"官方无用量接口"）。
- 用户问"我花了多少钱/还剩多少额度"：先跑 `balance`；再跑 `usage` 给出 token 明细，并说明**计费以 platform.deepseek.com 用量页为准**（DeepSeek 的定价区分缓存命中/未命中，脚本目前不汇总复杂的费用换算，因此不要盲目用价格表反推金额）。
- 始终不要 echo / 打印 API key；`balance` 的输出已经包含"凭证来源"，够用了。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `error: 找不到 API key` | 设 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`，或在配置里写 `provider.apiKey: "${ENV_VAR}"` |
| `API key 被拒绝 (HTTP 401)` | key 与 base URL 不属于同一账户/区域；或 `--api-key` 传错 |
| `base URL 必须是 http(s) 绝对地址` | `--base-url` / `$DEEPSEEK_BASE_URL` 传了相对路径或空串；空串会回落到默认 `https://api.deepseek.com`，相对路径必须改成完整 URL |
| `error: 日志路径不存在` | `--log` 路径写错；或该环境下 `$ZHENTE_LOG_FILE` 指向的文件已被清理 |
| `扫描文件: 0` | 该环境没写日志文件（日志只在 stderr）；用 `--log` 指定 IDE 的 `idea*.log`，或设 `ZHENTE_LOG_DIR` |
| 有请求数但 token 全是 0 | `streamIncludeUsage=false` 或老日志/请求中途失败/取消，见上一节 |
| `数字比预期小` | `--since` / `--until` 过滤，或只扫了最近 N 个 IDE 日志（`--ide-log-files` 调大） |
| 报 404 且端点是别的域名 | 借用了当前项目的 `provider.baseURL`（脚本会同时打 warning）；传 `--base-url https://api.deepseek.com` 或设 `$DEEPSEEK_BASE_URL` |

## 局限（如实告知用户）

- 本地聚合是**客户端侧**统计：其他工具/网页/其他机器用同一账户的消耗不在其中。
- 没有成本换算：DeepSeek 价格随模型与缓存命中变化，脚本不内置价格表。
- 账单/发票/每日配额以 https://platform.deepseek.com 为准；本技能用于快速自查。
