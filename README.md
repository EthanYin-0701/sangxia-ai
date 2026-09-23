[简体中文](#简体中文)

# Sangxia.ai

A coding agent for JetBrains IDEs and Zed, connected through [ACP](https://agentclientprotocol.com). Use your own model API key to explore code, edit files, and run commands from your editor.

## Quick start

You need **Node.js 20+**, a [DeepSeek API key](https://platform.deepseek.com/api_keys), and either a JetBrains IDE with **AI Assistant** enabled or **Zed** with external-agent support. This guide uses **DeepSeek Flash** (`deepseek-flash`).

### 1. Build and configure DeepSeek

Sangxia is not yet published to npm or the ACP Registry. From the root of this checkout, run:

```bash
npm ci
npm run build
node dist/index.js setup --preset deepseek
```

Enter your DeepSeek API key when prompted; it is not echoed. `--preset deepseek` fills in the DeepSeek endpoint (`https://api.deepseek.com`) and a default model (`deepseek-flash`, which is `--provider openai`), so only the key is asked, and the editor's model picker gets `deepseek-flash` / `deepseek-v4-pro`. Explicit flags still win (e.g. `--preset deepseek --base-url … --model …`). Setup verifies connectivity and saves your settings in `~/.config/sangxia/config.json` with owner-only permissions.

Get the two absolute paths needed below:

```bash
node -p "process.execPath"
node -p "require('node:path').resolve('dist/index.js')"
```

Use the first output as `command` and the second as the first item in `args`. On Windows, use `/` or escape each `\` as `\\` in JSON paths.

### 2. Connect your editor

**JetBrains IDEs**

Open **AI Chat → menu in the upper-right corner → Add Custom Agent**. In the `~/.jetbrains/acp.json` file it opens, add:

```json
{
  "agent_servers": {
    "Sangxia": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/sangxia/dist/index.js"],
      "env": {}
    }
  }
}
```

**Zed**

Open **Agent Settings → External Agents → Add Agent → Add Custom Agent**. Add this entry to the settings file:

```json
{
  "agent_servers": {
    "Sangxia": {
      "type": "custom",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/sangxia/dist/index.js"],
      "env": {}
    }
  }
}
```

Replace both paths with the outputs from step 1. If `agent_servers` already exists, add `Sangxia` inside it. No `setup`, `tui`, or `--acp` argument is needed: Sangxia starts in ACP mode by default and reads the credentials saved by setup.

### 3. Start a conversation

Open your project, select **Sangxia** in JetBrains AI Chat or Zed's Agent Panel, and start a new conversation. Try:

> Explain this project's structure, then help me fix a small bug.

Approve file changes and commands when prompted. To change your model or API key, rerun setup and reconnect the agent.

## Useful notes

- **Configuration:** project `sangxia.config.json`, `SANGXIA_CONFIG`, or `--config` settings can override the global configuration. Check them if the editor uses an unexpected model.
- **First run / authentication:** with no usable config, the editor lists the agent's authentication methods (`使用 DeepSeek API Key 登录`, plus a generic terminal setup). Choosing the DeepSeek one runs `npx sangxia-ai setup --preset deepseek` in a terminal and asks for the API key only. Until then `session/new` fails with `-32000 Authentication required`, and that message repeats the same command.
- **API keys in environment variables:** add `--api-key-env DEEPSEEK_API_KEY` to the setup command after setting that variable. Setup saves a reference; the editor must also supply the variable through its agent `env` settings or inherited environment.
- **Terminal UI:** run `node dist/index.js tui` to chat directly in a terminal.
- **Extensions:** supports MCP tools, local skills, project instructions, and configurable hooks. See the [full documentation](INSTRUCTIONS.md).

Setup references: [JetBrains ACP](https://www.jetbrains.com/help/ai-assistant/acp.html) · [Zed custom agents](https://zed.dev/docs/ai/external-agents#custom-agents) · [DeepSeek API](https://api-docs.deepseek.com/).

License: [MIT](LICENSE).

---

## 简体中文

[English](#sangxiaai)

Sangxia.ai 是通过 [ACP](https://agentclientprotocol.com) 接入 JetBrains IDE 和 Zed 的编程 agent。使用自己的模型 API key，即可在编辑器中理解代码、修改文件和执行命令。

### 快速开始

准备 **Node.js 20+**、一个 [DeepSeek API key](https://platform.deepseek.com/api_keys)，以及启用了 **AI Assistant** 的 JetBrains IDE，或支持外部 agent 的 **Zed**。本教程默认使用 **DeepSeek Flash**（`deepseek-flash`）。

#### 1. 构建并配置 DeepSeek

Sangxia 尚未发布到 npm 或 ACP Registry。在本地仓库根目录运行：

```bash
npm ci
npm run build
node dist/index.js setup --preset deepseek
```

按提示输入 DeepSeek API key，输入不会回显。`--preset deepseek` 会自动填好 DeepSeek 端点（`https://api.deepseek.com`）与默认模型（`deepseek-flash`，即 `--provider openai`），所以只会问 key，并让编辑器的模型选择器出现 `deepseek-flash` / `deepseek-v4-pro`。显式参数仍然优先（如 `--preset deepseek --base-url … --model …`）。Setup 验证连接后，将配置保存到 `~/.config/sangxia/config.json`，文件权限仅限当前用户读写。

获取后续配置需要的两个绝对路径：

```bash
node -p "process.execPath"
node -p "require('node:path').resolve('dist/index.js')"
```

第一行输出填入 `command`，第二行输出填入 `args` 的第一项。Windows 的 JSON 路径请使用 `/`，或将每个 `\` 转义为 `\\`。

#### 2. 接入编辑器

**JetBrains IDE**

打开 **AI Chat → 右上角菜单 → Add Custom Agent**，在打开的 `~/.jetbrains/acp.json` 中添加：

```json
{
  "agent_servers": {
    "Sangxia": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/sangxia/dist/index.js"],
      "env": {}
    }
  }
}
```

**Zed**

打开 **Agent Settings → External Agents → Add Agent → Add Custom Agent**，在设置文件中添加：

```json
{
  "agent_servers": {
    "Sangxia": {
      "type": "custom",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/sangxia/dist/index.js"],
      "env": {}
    }
  }
}
```

将两处路径替换为第 1 步的输出。已有 `agent_servers` 时，把 `Sangxia` 加入其中即可。无需添加 `setup`、`tui` 或 `--acp` 参数：Sangxia 默认以 ACP 模式启动，并读取 setup 保存的凭据。

#### 3. 开始对话

打开项目，在 JetBrains AI Chat 或 Zed Agent Panel 中选择 **Sangxia**，新建对话。例如：

> 解释这个项目的结构，然后帮我修复一个小 bug。

按提示确认文件修改和命令执行。更换模型或 API key 时，重新运行 setup，再重新连接 agent。

### 补充说明

- **配置覆盖：**项目中的 `sangxia.config.json`、`SANGXIA_CONFIG` 或 `--config` 配置可以覆盖全局配置。模型与预期不符时，先检查这些设置。
- **首次运行与认证：**没有可用配置时，编辑器会列出本 agent 的认证方式（`使用 DeepSeek API Key 登录`，以及通用的终端配置）。选择前者会在终端运行 `npx sangxia-ai setup --preset deepseek`，只需输入 API key。在此之前新建会话会返回 `-32000 Authentication required`，错误信息里会重复同一条命令。
- **通过环境变量提供 key：**先设置 `DEEPSEEK_API_KEY`，再给 setup 命令添加 `--api-key-env DEEPSEEK_API_KEY`。此时只保存变量引用；编辑器启动 agent 时，也需通过 `env` 设置或继承环境提供该变量。
- **终端界面：**运行 `node dist/index.js tui` 即可在终端中对话。
- **扩展能力：**支持 MCP 工具、本地技能、项目指令和可配置 hooks。详见[完整文档](INSTRUCTIONS.md)。

配置参考：[JetBrains ACP](https://www.jetbrains.com/help/ai-assistant/acp.html) · [Zed 自定义 agent](https://zed.dev/docs/ai/external-agents#custom-agents) · [DeepSeek API](https://api-docs.deepseek.com/zh-cn/)。

许可证：[MIT](LICENSE)。
