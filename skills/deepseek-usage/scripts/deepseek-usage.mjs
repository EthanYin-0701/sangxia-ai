#!/usr/bin/env node
/**
 * deepseek-usage.mjs — 查询 DeepSeek 账户余额 + 汇总本地 token 用量。零依赖，Node >= 20。
 *
 *   node deepseek-usage.mjs balance [--json] [--api-key K] [--base-url U] [--config P]
 *   node deepseek-usage.mjs usage   [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *                                   [--log FILE|DIR]... [--ide-logs|--no-ide-logs]
 *                                   [--ide-log-files N] [--json] [--config P]
 *
 * 设计要点：
 * - 绝不打印 API key，只打印凭证来源（环境变量名 / 配置文件路径）。
 * - balance 走官方 GET <base>/user/balance（DeepSeek 唯一公开的账户接口）。
 * - usage 无官方接口，改为聚合 Sangxia 日志（SANGXIA_LOG_DIR / SANGXIA_LOG_FILE /
 *   ~/.config/sangxia/logs）里 `LLM request end … usage={…}` 行的 token 数；
 *   没有 Sangxia 日志时回落到最近修改的 JetBrains IDE 日志（agent stderr 被 IDE 记录）。
 * - 日志按流读取 + 按 (时间戳, model, usage) 去重，重复扫描同一文件不会重复计数。
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const USAGE = `deepseek-usage — DeepSeek 余额 / 本地 token 用量

  balance                     查询账户余额（官方 GET /user/balance）
  usage                       汇总本地 token 用量（Sangxia 日志 / IDE 日志）

balance 选项
  --api-key <key>             API key（默认 DEEPSEEK_API_KEY → OPENAI_API_KEY → 配置文件）
  --base-url <url>            API base（默认 DEEPSEEK_BASE_URL → 配置 provider.baseURL → https://api.deepseek.com）
  --json                      机器可读输出

usage 选项
  --since <YYYY-MM-DD>        只统计该日期（含）之后的请求
  --until <YYYY-MM-DD>        只统计该日期（含）之前的请求
  --log <file|dir>            指定日志文件或目录（可重复；目录取 *.log，不递归）
  --ide-logs                  强制使用 JetBrains IDE 日志
  --no-ide-logs               只读 Sangxia 日志，不用 IDE 日志兜底
  --ide-log-files <n>         兜底时最多扫描最近修改的 n 个 IDE 日志（默认 15）
  --json                      机器可读输出

公共选项
  --config <path>             sangxia 配置文件（默认 $SANGXIA_CONFIG → ./sangxia.config.json → ~/.config/sangxia/config.json）
  -h, --help                  显示本帮助
`;

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {
    command: undefined,
    logs: [],
    json: false,
    since: undefined,
    until: undefined,
    apiKey: undefined,
    baseURL: undefined,
    config: undefined,
    ideLogs: undefined, // true=强制, false=禁用, undefined=自动
    ideLogFiles: 15,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`选项 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case "--json": opts.json = true; break;
      case "--help":
      case "-h": opts.help = true; break;
      case "--since": opts.since = dateArg(arg, next()); break;
      case "--until": opts.until = dateArg(arg, next()); break;
      case "--log": opts.logs.push(next()); break;
      case "--api-key": opts.apiKey = next(); break;
      case "--base-url": opts.baseURL = next(); break;
      case "--config": opts.config = next(); break;
      case "--ide-logs": opts.ideLogs = true; break;
      case "--no-ide-logs": opts.ideLogs = false; break;
      case "--ide-log-files": opts.ideLogFiles = positiveInt(arg, next()); break;
      default:
        if (arg.startsWith("-")) fail(`未知选项: ${arg}（用 --help 查看用法）`);
        positional.push(arg);
    }
  }
  if (positional.length > 1) fail(`多余的参数: ${positional.slice(1).join(" ")}`);
  opts.command = positional[0];
  return opts;
}

function dateArg(name, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${name} 需要 YYYY-MM-DD 格式，收到: ${value}`);
  return value;
}

function positiveInt(name, value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} 需要正整数，收到: ${value}`);
  return n;
}

// ---------------------------------------------------------------- config / credentials

function interpolate(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name) => process.env[name] ?? "");
}

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p));
}

function loadConfig(explicitPath) {
  const path =
    explicitPath ??
    process.env.SANGXIA_CONFIG ??
    firstExisting([resolve("sangxia.config.json"), join(homedir(), ".config", "sangxia", "config.json")]);
  if (!path) return { path: undefined, data: {} };
  if (!existsSync(path)) {
    if (explicitPath) fail(`配置文件不存在: ${path}`);
    return { path: undefined, data: {} };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`配置文件解析失败 (${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { path, data: data ?? {} };
}

/** 凭证优先级：--api-key → DEEPSEEK_API_KEY → OPENAI_API_KEY → 配置 provider.apiKey（支持 ${ENV}）。 */
function resolveCredential(opts, cfg) {
  const fromConfig = cfg.data?.provider?.apiKey ? interpolate(cfg.data.provider.apiKey) : "";
  const candidates = [
    ["--api-key", opts.apiKey],
    ["$DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY],
    ["$OPENAI_API_KEY", process.env.OPENAI_API_KEY],
    [cfg.path ? `config ${cfg.path} provider.apiKey` : "config provider.apiKey", fromConfig],
  ];
  for (const [source, value] of candidates) {
    if (value && String(value).trim()) return { apiKey: String(value).trim(), source };
  }
  fail(
    "找不到 API key。请设置 DEEPSEEK_API_KEY（或 OPENAI_API_KEY），" +
      "或在 sangxia.config.json 的 provider.apiKey 里用 ${ENV_VAR} 引用；也可显式传 --api-key。",
  );
}

function resolveBaseURL(opts, cfg) {
  // 每一级都要把空串归一成 undefined：`"" ?? x` 会返回 ""，从而绕过默认值，
  // 让 balanceEndpoints("") 生成相对 URL "/user/balance" → fetch 抛 "Invalid URL"。
  const fromConfig = cfg.data?.provider?.baseURL
    ? interpolate(cfg.data.provider.baseURL).trim() || undefined
    : undefined;
  const candidates = [
    ["--base-url", opts.baseURL?.trim()],
    ["$DEEPSEEK_BASE_URL", process.env.DEEPSEEK_BASE_URL?.trim()],
    [cfg.path ? `config ${cfg.path} provider.baseURL` : undefined, fromConfig],
    ["默认值", "https://api.deepseek.com"],
  ];
  const hit = candidates.find(([, value]) => value);
  const base = hit[1];
  if (!/^https?:\/\//i.test(base)) {
    fail(`base URL 必须是 http(s) 绝对地址，收到: ${JSON.stringify(base)}`);
  }
  return { base, source: hit[0] };
}

/**
 * 跨项目使用时最容易出错的地方：另一个项目的 sangxia.config.json 可能指向别的厂商
 * （或别的网关），此时 base URL 会被静默借用，余额查询报 404/401 而不是给出默认端点。
 * 检测到这种"非 deepseek 域名 + 来自配置文件"的组合就提醒一句，只在 stderr。
 */
function warnIfForeignBase(base, source) {
  if (!source?.startsWith("config ")) return;
  try {
    if (/(^|\.)deepseek\.com$/i.test(new URL(base).hostname)) return;
  } catch {
    return;
  }
  console.error(
    `warning: base URL 来自配置文件的 provider.baseURL（${base}），看起来不是 DeepSeek 端点。` +
      `如需查 DeepSeek 账户，请传 --base-url https://api.deepseek.com 或设置 $DEEPSEEK_BASE_URL。`,
  );
}

// ---------------------------------------------------------------- balance

/** base 结尾是 /v1 时准备两个候选端点（DeepSeek 两种 base 写法都常见）。 */
function balanceEndpoints(base) {
  const trimmed = base.replace(/\/+$/, "");
  const urls = [`${trimmed}/user/balance`];
  if (/\/v1$/.test(trimmed)) urls.push(`${trimmed.slice(0, -"/v1".length)}/user/balance`);
  return urls;
}

async function cmdBalance(opts) {
  const cfg = loadConfig(opts.config);
  const { apiKey, source } = resolveCredential(opts, cfg);
  const { base, source: baseSource } = resolveBaseURL(opts, cfg);
  warnIfForeignBase(base, baseSource);
  const endpoints = balanceEndpoints(base);

  let lastError;
  for (const endpoint of endpoints) {
    let res;
    try {
      res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = new Error(
        `请求失败 (${endpoint}): ${err instanceof Error ? err.message : String(err)}` +
          (err?.name === "TimeoutError" ? "（20s 超时）" : ""),
      );
      continue;
    }

    const body = await res.text().catch(() => "");
    if (res.status === 404 && endpoint !== endpoints[endpoints.length - 1]) {
      lastError = new Error(`端点不存在 (404 ${endpoint})`);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      fail(
        `API key 被拒绝 (HTTP ${res.status})。凭证来源: ${source}；端点: ${endpoint}。` +
          `请确认 key 有效、与 base URL(${base}) 属于同一账户/区域。`,
      );
    }
    if (!res.ok) {
      const snippet = body.replace(/\s+/g, " ").slice(0, 300);
      fail(`余额接口返回 HTTP ${res.status} (${endpoint}): ${snippet || "<空响应>"}`);
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      fail(`余额接口返回的不是 JSON (${endpoint}): ${body.slice(0, 300)}`);
    }

    if (opts.json) {
      printJson({
        ok: true,
        endpoint,
        baseUrlSource: baseSource,
        credentialSource: source,
        isAvailable: data?.is_available ?? null,
        balances: data?.balance_infos ?? [],
      });
      return;
    }
    printBalance(endpoint, source, data, baseSource);
    return;
  }
  throw lastError ?? new Error("余额查询失败");
}

function printBalance(endpoint, source, data, baseSource) {
  const available = data?.is_available;
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  console.log("DeepSeek 账户余额");
  console.log(`  端点: ${endpoint}${baseSource ? `（base URL 来自 ${baseSource}）` : ""}`);
  console.log(`  凭证来源: ${source}`);
  console.log(`  可用状态: ${available === true ? "可用 (is_available=true)" : available === false ? "不可用 (is_available=false)" : "未知"}`);
  if (infos.length === 0) {
    console.log("  (接口未返回 balance_infos)");
    return;
  }
  for (const info of infos) {
    const currency = info?.currency ?? "?";
    console.log("");
    console.log(`  ${currency}`);
    console.log(`    总余额       ${amount(info?.total_balance)}`);
    console.log(`    赠送余额     ${amount(info?.granted_balance)}`);
    console.log(`    充值余额     ${amount(info?.topped_up_balance)}`);
  }
}

function amount(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value ?? "-");
}

// ---------------------------------------------------------------- usage

/** 从候选路径（文件/目录）解析出实际要扫描的日志文件。 */
function collectLogFiles(opts, cfg) {
  const files = [];
  const dirs = [];
  const notes = [];

  for (const raw of opts.logs) {
    const p = resolve(raw);
    if (!existsSync(p)) fail(`日志路径不存在: ${p}`);
    if (statSync(p).isDirectory()) dirs.push(p);
    else files.push(p);
  }

  const envDir = process.env.SANGXIA_LOG_DIR;
  if (envDir && existsSync(envDir)) dirs.push(envDir);
  const envFile = process.env.SANGXIA_LOG_FILE;
  if (envFile && existsSync(envFile)) files.push(envFile);

  const defaultDir = join(homedir(), ".config", "sangxia", "logs");
  if (files.length === 0 && dirs.length === 0 && existsSync(defaultDir)) dirs.push(defaultDir);

  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch (err) {
      notes.push(`无法读取目录 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const name of names) if (name.endsWith(".log")) files.push(join(dir, name));
  }

  const unique = [...new Set(files)].filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });

  if (unique.length > 0) {
    return { files: unique, source: opts.logs.length > 0 ? "指定的日志路径" : "Sangxia 日志", notes };
  }
  if (opts.ideLogs === false) {
    return { files: [], source: "none", notes };
  }

  // 没有 Sangxia 日志文件时兜底：IDE 会把 agent 的 stderr（含 log 行）记进自己的 idea*.log。
  const ide = collectIdeLogFiles(opts.ideLogFiles);
  if (ide.files.length > 0) {
    return {
      files: ide.files,
      source: `${ide.root} 下最近修改的 ${ide.files.length} 个日志文件`,
      notes: [...notes, ...ide.notes],
    };
  }
  return { files: [], source: "none", notes };
}

function jetbrainsLogRoots() {
  const home = homedir();
  if (process.platform === "darwin") return [join(home, "Library", "Logs", "JetBrains")];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(local, "JetBrains")];
  }
  return [join(home, ".cache", "JetBrains")];
}

function collectIdeLogFiles(limit) {
  const notes = [];
  for (const root of jetbrainsLogRoots()) {
    if (!existsSync(root)) continue;
    const found = [];
    let products = [];
    try {
      products = readdirSync(root);
    } catch (err) {
      notes.push(`无法读取 ${root}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const product of products) {
      const productDir = join(root, product);
      for (const candidate of [productDir, join(productDir, "log")]) {
        let names = [];
        try {
          names = readdirSync(candidate);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".log")) continue;
          const file = join(candidate, name);
          try {
            // 只 stat 一次：两次调用之间文件可能被删除，第二次会抛出未被捕获的异常。
            const stats = statSync(file);
            if (stats.isFile()) found.push({ file, mtime: stats.mtimeMs });
          } catch {
            /* skip */
          }
        }
      }
    }
    if (found.length === 0) continue;
    const picked = found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    notes.push(`候选 IDE 日志 ${found.length} 个，按修改时间取前 ${picked.length} 个`);
    return { root, files: picked.map((x) => x.file), notes };
  }
  const roots = jetbrainsLogRoots().join(", ");
  return { root: roots, files: [], notes: [`未找到 JetBrains 日志目录: ${roots}`] };
}

/** 统计一行里最后一个时间戳（IDE 前缀的时间戳 vs agent stderr 自己的时间戳，取后者）。 */
function lastTimestamp(text) {
  const re = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g;
  let match;
  let last;
  while ((match = re.exec(text)) !== null) last = match[0];
  return last;
}

function normalizeTimestamp(ts) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(ts ?? "");
  return m ? `${m[1]}T${m[2]}` : (ts ?? "unknown");
}

function emptyBucket() {
  return { requests: 0, withUsage: 0, prompt: 0, completion: 0, reasoning: 0, total: 0, cacheHit: 0, cacheMiss: 0 };
}

/**
 * 单条 usage 的 total。
 * 用 `||` 而不是 `??`：`total_tokens` 显式等于 0（占位值/异常响应）时也要回落到
 * prompt+completion —— 真实请求的 total 至少为 prompt+completion，0 只可能是"没提供"。
 * 顺带把 NaN 也归一化了（NaN 是 falsy）。`??` 会把这个 0 当成有效值照抄。
 */
function usageTotal(usage) {
  return num(usage.total_tokens || num(usage.prompt_tokens) + num(usage.completion_tokens));
}

function addUsage(bucket, usage) {
  bucket.requests++;
  bucket.withUsage++;
  bucket.prompt += num(usage.prompt_tokens);
  bucket.completion += num(usage.completion_tokens);
  bucket.reasoning += num(usage.reasoning_tokens);
  bucket.total += usageTotal(usage);
  const hit = num(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const miss = num(usage.prompt_cache_miss_tokens);
  bucket.cacheHit += hit;
  bucket.cacheMiss += miss;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mergeBucket(target, from) {
  target.requests += from.requests;
  target.withUsage += from.withUsage;
  target.prompt += from.prompt;
  target.completion += from.completion;
  target.reasoning += from.reasoning;
  target.total += from.total;
  target.cacheHit += from.cacheHit;
  target.cacheMiss += from.cacheMiss;
}

async function cmdUsage(opts) {
  const cfg = loadConfig(opts.config);
  const { files, source, notes } = collectLogFiles(opts, cfg);

  const state = {
    files: files.length,
    filePaths: files,
    matched: 0,
    withUsage: 0,
    noUsage: 0,
    unparsable: 0,
    duplicates: 0,
    filtered: 0,
    seen: new Set(),
    byDate: new Map(),
    byModel: new Map(),
    total: emptyBucket(),
    minDate: undefined,
    maxDate: undefined,
  };

  for (const file of files) {
    await scanLogFile(file, opts, state);
  }

  if (opts.json) {
    printJson({
      ok: true,
      source,
      notes,
      fileCount: state.files,
      filePaths: state.filePaths,
      matchedRequests: state.matched,
      requestsWithUsage: state.withUsage,
      requestsWithoutUsage: state.noUsage,
      unparsableUsage: state.unparsable,
      duplicatesSkipped: state.duplicates,
      filteredOut: state.filtered,
      unreadableFiles: state.unreadable ?? [],
      range: { since: opts.since ?? null, until: opts.until ?? null },
      firstDate: state.minDate ?? null,
      lastDate: state.maxDate ?? null,
      totals: state.total,
      byDate: [...state.byDate.entries()].sort().map(([date, b]) => ({ date, ...b })),
      byModel: [...state.byModel.entries()].sort().map(([model, b]) => ({ model, ...b })),
    });
    return;
  }
  printUsageReport(opts, state, { source, notes });
}

async function scanLogFile(file, opts, state) {
  let stream;
  try {
    stream = createReadStream(file, { encoding: "utf8" });
  } catch (err) {
    // createReadStream 是惰性的：ENOENT / EACCES / EISDIR 都是**异步** error 事件，
    // 由下面的 for-await（外层 try）捕获并记入 state.unreadable。这里只可能接住同步抛出的
    // 编程错误（例如非法 encoding）。既然接住了就必须记账——静默 return 会让该文件在
    // 扫描计数和"读取失败"报告里同时消失。
    state.unreadable = [...(state.unreadable ?? []), `${file}: ${err instanceof Error ? err.message : String(err)}`];
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const marker = line.indexOf("LLM request end");
      if (marker < 0) continue;
      state.matched++;

      const model = /model=(\S+)/.exec(line)?.[1] ?? "unknown";
      const normalizedLine = line.slice(marker).trimEnd();
      const ts = normalizeTimestamp(lastTimestamp(line.slice(0, marker)));
      const date = /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : "unknown";

      if ((opts.since && date < opts.since) || (opts.until && date > opts.until)) {
        state.filtered++;
        continue;
      }

      const usageIndex = line.lastIndexOf("usage=");
      const rawUsage = usageIndex >= 0 ? line.slice(usageIndex + "usage=".length).trim() : "";
      let usage;
      if (!rawUsage || rawUsage === "undefined") {
        usage = undefined;
      } else {
        try {
          usage = JSON.parse(rawUsage);
        } catch {
          usage = undefined;
          state.unparsable++;
        }
      }

      // 去重用整条 agent 日志内容（含 elapsedMs/chunks/session），只把 IDE 前缀剥掉：
      // 同一秒、同模型、同 usage 的两次真实请求不会被误判为重复。
      const key = `${ts}|${normalizedLine}`;
      if (state.seen.has(key)) {
        state.duplicates++;
        continue;
      }
      state.seen.add(key);

      if (date !== "unknown") {
        if (!state.minDate || date < state.minDate) state.minDate = date;
        if (!state.maxDate || date > state.maxDate) state.maxDate = date;
      }

      const bucket = getBucket(state.byDate, date);
      const modelBucket = getBucket(state.byModel, model);
      if (usage && typeof usage === "object") {
        state.withUsage++;
        addUsage(bucket, usage);
        addUsage(modelBucket, usage);
        mergeBucket(state.total, {
          requests: 1,
          withUsage: 1,
          prompt: num(usage.prompt_tokens),
          completion: num(usage.completion_tokens),
          reasoning: num(usage.reasoning_tokens),
          total: usageTotal(usage),
        });
      } else {
        state.noUsage++;
        bucket.requests++;
        modelBucket.requests++;
        state.total.requests++;
      }
    }
  } catch (err) {
    state.unreadable = [...(state.unreadable ?? []), `${file}: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    rl.close();
    stream.destroy();
  }
}

function getBucket(map, key) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyBucket();
    map.set(key, bucket);
  }
  return bucket;
}

const fmt = (n) => n.toLocaleString("en-US");

function printUsageReport(opts, state, { source, notes }) {
  console.log("本地 token 用量");
  console.log(`  数据源: ${source === "none" ? "未找到日志（见下方提示）" : source}`);
  if (notes?.length) for (const note of notes) console.log(`  提示: ${note}`);
  const paths = state.filePaths ?? [];
  if (paths.length > 0 && paths.length <= 3) for (const file of paths) console.log(`  文件: ${file}`);
  console.log(
    `  扫描文件: ${state.files}   命中 "LLM request end": ${fmt(state.matched)}   含 usage: ${fmt(state.withUsage)}   ` +
      `无 usage 记录: ${fmt(state.noUsage)}`,
  );
  if (state.unparsable > 0) console.log(`  usage 解析失败: ${fmt(state.unparsable)}（日志被截断？）`);
  if (state.duplicates > 0) console.log(`  重复行已去重: ${fmt(state.duplicates)}`);
  if (state.filtered > 0) console.log(`  被 --since/--until 过滤: ${fmt(state.filtered)}`);
  if (state.unreadable?.length) for (const item of state.unreadable) console.log(`  读取失败: ${item}`);
  const range = state.minDate && state.maxDate ? `${state.minDate} .. ${state.maxDate}` : "（范围内无数据）";
  console.log(`  时间范围: ${range}`);

  if (state.files === 0) {
    console.log("");
    console.log(
      "未找到可扫描的日志。可以：① 在 sangxia.config.json 里设 provider.streamIncludeUsage=true 并设置 " +
        "SANGXIA_LOG_DIR（或 --log 指向 sangxia-acp.log / IDE 的 idea*.log）；② 账户级用量请到 https://platform.deepseek.com 查看。",
    );
    return;
  }

  if (state.byDate.size > 0) {
    console.log("");
    console.log("按日期");
    console.log(`  ${pad("日期", 12)}${pad("请求", 8)}${pad("prompt", 14)}${pad("completion", 14)}${pad("reasoning", 12)}${pad("total", 14)}`);
    for (const [date, b] of [...state.byDate.entries()].sort()) {
      console.log(`  ${pad(date, 12)}${pad(fmt(b.requests), 8)}${pad(fmt(b.prompt), 14)}${pad(fmt(b.completion), 14)}${pad(fmt(b.reasoning), 12)}${pad(fmt(b.total), 14)}`);
    }
  }

  if (state.byModel.size > 0) {
    console.log("");
    console.log("按模型");
    console.log(`  ${pad("模型", 28)}${pad("请求", 8)}${pad("prompt", 14)}${pad("completion", 14)}${pad("total", 14)}`);
    for (const [model, b] of [...state.byModel.entries()].sort()) {
      console.log(`  ${pad(model, 28)}${pad(fmt(b.requests), 8)}${pad(fmt(b.prompt), 14)}${pad(fmt(b.completion), 14)}${pad(fmt(b.total), 14)}`);
    }
  }

  console.log("");
  console.log("合计");
  console.log(`  请求: ${fmt(state.total.requests)}（含 usage 的 ${fmt(state.total.withUsage)} 条）`);
  console.log(`  prompt tokens:     ${fmt(state.total.prompt)}`);
  if (state.total.cacheHit > 0 || state.total.cacheMiss > 0) {
    const totalCache = state.total.cacheHit + state.total.cacheMiss;
    const hitPct = totalCache > 0 ? ((state.total.cacheHit / totalCache) * 100).toFixed(1) : "0.0";
    console.log(`    其中缓存命中:   ${fmt(state.total.cacheHit)} (${hitPct}%)`);
    console.log(`    其中缓存未命中: ${fmt(state.total.cacheMiss)}`);
  }
  console.log(`  completion tokens: ${fmt(state.total.completion)}`);
  console.log(`  reasoning tokens:  ${fmt(state.total.reasoning)}`);
  console.log(`  total tokens:      ${fmt(state.total.total)}`);

  if (state.withUsage < state.matched) {
    console.log("");
    console.log(
      "注意: 只有 provider.streamIncludeUsage=true 的请求才会在日志里带 usage，" +
        "所以“无 usage 记录”的请求无 token 明细；账户级计费明细请到 https://platform.deepseek.com 用量页核对。",
    );
  }
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? `${s} ` : s + " ".repeat(width - s.length);
}

// ---------------------------------------------------------------- output

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.command) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  if (opts.command === "balance") await cmdBalance(opts);
  else if (opts.command === "usage") await cmdUsage(opts);
  else fail(`未知子命令: ${opts.command}（支持 balance / usage）`);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
