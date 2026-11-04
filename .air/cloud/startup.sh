#!/bin/sh
set -e

echo "[air-startup] Starting Air Cloud environment & agent monitoring..."

# ==============================================================================
# !!!!!! 【手工填写区】如果你没有在 Air 网页端配置环境变量，请直接修改下面引号中的默认值
# ==============================================================================
# export PROMETHEUS_REMOTE_WRITE_URL="${PROMETHEUS_REMOTE_WRITE_URL:-}"
# export PROMETHEUS_USER="${PROMETHEUS_USER:-}"
# export PROMETHEUS_PASSWORD="${PROMETHEUS_PASSWORD:-}"
# export GRAFANA_URL="${GRAFANA_URL:-}"
# export GRAFANA_SERVICE_TOKEN="${GRAFANA_SERVICE_TOKEN:-}"
# export AIR_LLM_MODEL="${AIR_LLM_MODEL:-gemini-default}"

# ==============================================================================
# 以下内容全部自动运行，无需手工修改
# ==============================================================================

# 1. 创建 Alloy 指标目录
TEXTFILE_DIR="/var/lib/alloy/textfile"
sudo mkdir -p "$TEXTFILE_DIR"
sudo chown -R "$(whoami)" "$TEXTFILE_DIR"

# 2. 按需安装 jq, curl, gpg, unzip, grafana-alloy (幂等)
if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 \
  || ! command -v gpg >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq jq curl ca-certificates gnupg unzip
fi

# 安装方式 A（首选）：Grafana 官方 apt 源。
# 注意：函数在 if 条件里调用时 set -e 不生效，所以每一步都要显式 || return 1。
install_alloy_from_apt() {
  KEY_DIR="$(mktemp -d)" || return 1
  # 分步执行：POSIX sh 的 set -e 无法捕获管道中间的下载/验签失败。
  if ! curl --fail --silent --show-error --location https://apt.grafana.com/gpg.key -o "$KEY_DIR/grafana.asc"; then
    echo "[air-startup] Cannot download Grafana signing key from apt.grafana.com (proxy blocked?)." >&2
    rm -rf "$KEY_DIR"
    return 1
  fi
  if ! gpg --batch --yes --dearmor --output "$KEY_DIR/grafana.gpg" "$KEY_DIR/grafana.asc"; then
    rm -rf "$KEY_DIR"
    return 1
  fi
  if ! sudo mkdir -p /etc/apt/keyrings/ || ! sudo install -m 0644 "$KEY_DIR/grafana.gpg" /etc/apt/keyrings/grafana.gpg; then
    rm -rf "$KEY_DIR"
    return 1
  fi
  rm -rf "$KEY_DIR"
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list >/dev/null || return 1
  if ! sudo apt-get update -qq -o APT::Update::Error-Mode=any || ! sudo apt-get install -y -qq alloy; then
    # 失败时移除 Grafana 源，避免污染后续所有 apt-get update。
    sudo rm -f /etc/apt/sources.list.d/grafana.list
    return 1
  fi
}

# 安装方式 B（回退）：GitHub Releases 二进制。Air Cloud 代理常常拦截 apt.grafana.com 但放行 github.com。
# 可通过 ALLOY_VERSION=v1.21.3 固定版本；默认解析最新 release。
install_alloy_from_github() {
  case "$(uname -m)" in
    x86_64|amd64) ALLOY_ARCH="amd64" ;;
    aarch64|arm64) ALLOY_ARCH="arm64" ;;
    *) echo "[air-startup] Unsupported architecture for Alloy binary: $(uname -m)" >&2; return 1 ;;
  esac
  ALLOY_VERSION="${ALLOY_VERSION:-}"
  if [ -z "$ALLOY_VERSION" ]; then
    ALLOY_VERSION="$(curl --fail --silent --location -o /dev/null -w '%{url_effective}' \
      https://github.com/grafana/alloy/releases/latest 2>/dev/null | sed -n 's#.*/tag/\(v[0-9][0-9.]*\)$#\1#p')"
  fi
  # 解析失败时退回到一个已知可用的版本。
  ALLOY_VERSION="${ALLOY_VERSION:-v1.21.3}"
  DL_DIR="$(mktemp -d)" || return 1
  ALLOY_URL="https://github.com/grafana/alloy/releases/download/${ALLOY_VERSION}/alloy-linux-${ALLOY_ARCH}.zip"
  echo "[air-startup] Downloading Alloy ${ALLOY_VERSION} (${ALLOY_ARCH}) from GitHub Releases..."
  if ! curl --fail --silent --show-error --location "$ALLOY_URL" -o "$DL_DIR/alloy.zip"; then
    echo "[air-startup] Cannot download ${ALLOY_URL}" >&2
    rm -rf "$DL_DIR"
    return 1
  fi
  # zip 内只有一个文件：alloy-linux-<arch>
  if ! unzip -q -o "$DL_DIR/alloy.zip" -d "$DL_DIR" || [ ! -f "$DL_DIR/alloy-linux-${ALLOY_ARCH}" ]; then
    echo "[air-startup] Unexpected Alloy archive layout." >&2
    rm -rf "$DL_DIR"
    return 1
  fi
  if ! sudo install -m 0755 "$DL_DIR/alloy-linux-${ALLOY_ARCH}" /usr/local/bin/alloy; then
    rm -rf "$DL_DIR"
    return 1
  fi
  rm -rf "$DL_DIR"
}

if ! command -v alloy >/dev/null 2>&1; then
  if install_alloy_from_apt; then
    echo "[air-startup] Installed Grafana Alloy from apt.grafana.com."
  elif install_alloy_from_github; then
    echo "[air-startup] apt.grafana.com unavailable; installed Grafana Alloy from GitHub Releases."
  else
    echo "[air-startup] Failed to install Grafana Alloy via both apt.grafana.com and GitHub Releases. Check Air Cloud proxy access." >&2
    exit 1
  fi
fi

# 3. 采集 Air Cloud 自身 Agent (Junie / Claude / Codex) 的运行状态与起止时间
cat << 'EOF' | sudo tee /usr/local/bin/air-agent-collector.sh >/dev/null
#!/bin/sh
OUT_FILE="/var/lib/alloy/textfile/air_agent.prom"
HOST_NAME="$(hostname)"
ENV_BOOT_TS="$(stat -c %Y /proc/1 2>/dev/null || date +%s)"

# Prometheus labels escape backslashes, double quotes and newlines.
escape_label() {
  jq -nr --arg value "$1" '$value | split("\\") | join("\\\\") | split("\"") | join("\\\"") | split("\n") | join("\\n")'
}
make_labels() {
  printf 'host="%s",project="%s",session_id="%s",agent_type="%s",llm_model="%s"' \
    "$(escape_label "$HOST_NAME")" "$(escape_label "$1")" \
    "$(escape_label "$2")" "$3" "$(escape_label "$4")"
}
# emit_process_state <running 0|1> <session_id> <agent_type>
emit_process_state() {
  LABELS="$(make_labels sangxia-ai "$2" "$3" "$DEFAULT_MODEL")"
  printf '%s\n' "air_cloud_agent_state{${LABELS}} $1" >> "$TMP_FILE"
  if [ "$1" -eq 1 ]; then
    printf '%s\n' "air_cloud_agent_start_timestamp_seconds{${LABELS}} ${ENV_BOOT_TS}" >> "$TMP_FILE"
    printf '%s\n' "air_cloud_agent_last_active_timestamp_seconds{${LABELS}} ${NOW_TS}" >> "$TMP_FILE"
  fi
}

while true; do
  TMP_FILE="${OUT_FILE}.tmp"
  : > "$TMP_FILE"
  NOW_TS="$(date +%s)"

  # 识别不同平台 Agent 的运行状态
  JUNIE_RUNNING=0
  CLAUDE_RUNNING=0
  CODEX_RUNNING=0

  # Match the executable name only (bare or path-prefixed, optionally .exe/.js);
  # a plain substring match hits unrelated processes such as the Air sidecar
  # supervisor, whose inline script mentions "junie-live".
  pgrep -f '(^|[ /])junie(\.exe|\.js)?( |$)' >/dev/null 2>&1 && JUNIE_RUNNING=1
  pgrep -f '(^|[ /])claude(\.exe|\.js)?( |$)' >/dev/null 2>&1 && CLAUDE_RUNNING=1
  pgrep -f '(^|[ /])codex(\.exe|\.js)?( |$)' >/dev/null 2>&1 && CODEX_RUNNING=1

  DEFAULT_MODEL="${AIR_LLM_MODEL:-default}"

  # 1. 遍历 ~/.junie/sessions/index.jsonl 中记录的所有会话
  INDEX_FILE="$HOME/.junie/sessions/index.jsonl"

  if [ -f "$INDEX_FILE" ] && command -v jq >/dev/null 2>&1; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      SID=$(echo "$line" | jq -r '.id // .sessionId // empty' 2>/dev/null)
      [ -z "$SID" ] && continue

      PROJ=$(echo "$line" | jq -r '.projectName // .project // "sangxia-ai"' 2>/dev/null)
      MODEL=$(echo "$line" | jq -r '.model // empty' 2>/dev/null)
      [ -z "$MODEL" ] && MODEL="$DEFAULT_MODEL"

      START_TS=$(echo "$line" | jq -r '(.created // .startTime // 0) / 1000 | floor' 2>/dev/null)
      [ -z "$START_TS" ] || [ "$START_TS" -le 0 ] && START_TS="$ENV_BOOT_TS"

      LAST_TS=$(echo "$line" | jq -r '(.updated // .lastActiveTime // 0) / 1000 | floor' 2>/dev/null)
      [ -z "$LAST_TS" ] || [ "$LAST_TS" -le 0 ] && LAST_TS="$NOW_TS"

      LABELS="$(make_labels "$PROJ" "$SID" junie "$MODEL")"
      # The index has no reliable per-session running signal; expose metadata only.
      printf '%s\n' "air_cloud_agent_start_timestamp_seconds{${LABELS}} ${START_TS}" >> "$TMP_FILE"
      printf '%s\n' "air_cloud_agent_last_active_timestamp_seconds{${LABELS}} ${LAST_TS}" >> "$TMP_FILE"
    done < "$INDEX_FILE"
  fi

  # 2. 其它 Agent 或无历史记录时的补充/兜底指标
  # Running state is process-level, separate from historical session metadata.
  # The state series is always written (0=IDLE, 1=RUNNING) so a stopped agent
  # shows as idle instead of the series going stale; timestamps only while running.
  emit_process_state "$CLAUDE_RUNNING" "claude-${HOST_NAME}" claude-code
  emit_process_state "$CODEX_RUNNING" "codex-${HOST_NAME}" codex
  emit_process_state "$JUNIE_RUNNING" "$HOST_NAME" junie

  mv "$TMP_FILE" "$OUT_FILE"
  sleep 5
done
EOF
sudo chmod +x /usr/local/bin/air-agent-collector.sh

# Replace the collector so reruns apply the updated script and environment.
COLLECTOR_PIDS="$(pgrep -f '^([^ ]*/)?(sh|dash) /usr/local/bin/air-agent-collector.sh$' || true)"
if [ -n "$COLLECTOR_PIDS" ]; then
  # The match also catches short-lived $(...) subshells of the collector that may
  # exit before kill runs; don't let that abort the whole script under set -e.
  kill $COLLECTOR_PIDS 2>/dev/null || true
  sleep 1
fi
nohup /usr/local/bin/air-agent-collector.sh >/tmp/air-agent-collector.log 2>&1 &

# 4. 启动 Grafana Alloy 推送 Air Cloud 的 CPU / 内存 / 网络 及 Agent 指标
if [ -n "${PROMETHEUS_REMOTE_WRITE_URL:-}" ]; then
  sudo mkdir -p /etc/alloy
  cat << 'EOF' | sudo tee /etc/alloy/config.alloy >/dev/null
prometheus.exporter.unix "air_cloud_host" {
  include_exporter_metrics = false
  textfile {
    directory = "/var/lib/alloy/textfile"
  }
}

prometheus.scrape "air_cloud_scrape" {
  targets         = prometheus.exporter.unix.air_cloud_host.targets
  forward_to      = [prometheus.remote_write.grafana_ready.receiver]
  scrape_interval = "10s"
}

prometheus.remote_write "grafana_ready" {
  endpoint {
    url = env("PROMETHEUS_REMOTE_WRITE_URL")
    proxy_from_environment = true
    // !!!!!! 如果你的自建 Prometheus 不需要账号密码认证，可以删掉下面整个 basic_auth { ... } 块
    basic_auth {
      username = env("PROMETHEUS_USER")
      password = env("PROMETHEUS_PASSWORD")
    }
  }
  external_labels = {
    host    = constants.hostname,
    project = "sangxia-ai",
    env     = "air-cloud",
  }
}
EOF
  sudo chmod 755 /etc/alloy
  sudo chmod 644 /etc/alloy/config.alloy

  # Stop the package service so it cannot race our environment-configured instance.
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if systemctl is-active --quiet alloy; then
      sudo systemctl stop alloy
    fi
  fi
  # Only replace the instance owned by this script, never an unrelated Alloy.
  ALLOY_PID_FILE=/tmp/air-alloy.pid
  if [ -f "$ALLOY_PID_FILE" ]; then
    ALLOY_PID="$(cat "$ALLOY_PID_FILE")"
    case "$ALLOY_PID" in
      ''|*[!0-9]*) ;;
      *)
        if [ -r "/proc/$ALLOY_PID/cmdline" ] && tr '\000' ' ' < "/proc/$ALLOY_PID/cmdline" | grep -q 'alloy run /etc/alloy/config.alloy --storage.path=/tmp/alloy-data'; then
          kill "$ALLOY_PID"
          for attempt in 1 2 3 4 5; do
            kill -0 "$ALLOY_PID" 2>/dev/null || break
            sleep 1
          done
          if kill -0 "$ALLOY_PID" 2>/dev/null; then
            echo "[air-startup] Previous Alloy has not stopped." >&2
            exit 1
          fi
        fi
        ;;
    esac
  fi
  nohup alloy run /etc/alloy/config.alloy --storage.path=/tmp/alloy-data >/tmp/alloy.log 2>&1 &
  ALLOY_PID=$!
  printf '%s\n' "$ALLOY_PID" > "$ALLOY_PID_FILE"
  sleep 1
  if ! kill -0 "$ALLOY_PID" 2>/dev/null; then
    echo "[air-startup] Alloy failed to start; see /tmp/alloy.log." >&2
    exit 1
  fi
else
  echo "[air-startup] WARNING: PROMETHEUS_REMOTE_WRITE_URL is empty; Alloy will NOT start and no metrics will reach Grafana." >&2
  echo "[air-startup]          Set PROMETHEUS_REMOTE_WRITE_URL / PROMETHEUS_USER / PROMETHEUS_PASSWORD in the Air env config or at the top of this script." >&2
fi

# 5. 自动向已就绪的 Grafana 实例注册/更新 Air Cloud 监控 Dashboard（可选）
if [ -n "${GRAFANA_URL:-}" ] && [ -n "${GRAFANA_SERVICE_TOKEN:-}" ]; then
  DASHBOARD_RESP="$(mktemp)"
  # The token is fed via stdin (-H @-, printf is a shell builtin) so it never shows up in ps.
  # Failure is reported but non-fatal: the dashboard is optional.
  if ! printf 'Authorization: Bearer %s\n' "$GRAFANA_SERVICE_TOKEN" | curl --fail-with-body -sS -X POST "${GRAFANA_URL%/}/api/dashboards/db" \
    -H @- \
    -H "Content-Type: application/json" \
    -o "$DASHBOARD_RESP" \
    -d '{
      "overwrite": true,
      "dashboard": {
        "id": null,
        "uid": "sangxia-air-cloud-monitor",
        "title": "Air Cloud - Agent & Environment Monitor (sangxia-ai)",
        "tags": ["air-cloud", "sangxia-ai", "agent"],
        "timezone": "browser",
        "schemaVersion": 39,
        "refresh": "10s",
        "time": { "from": "now-1h", "to": "now" },
        "panels": [
          {
            "id": 1,
            "type": "state-timeline",
            "title": "Agent Working State (0=IDLE, 1=RUNNING)",
            "gridPos": { "h": 6, "w": 24, "x": 0, "y": 0 },
            "targets": [{ "refId": "A", "expr": "air_cloud_agent_state{project=\"sangxia-ai\"}", "legendFormat": "{{host}} [{{agent_type}} / {{llm_model}}]" }]
          },
          {
            "id": 2,
            "type": "table",
            "title": "Agent Start / Last Active Time & Metadata",
            "gridPos": { "h": 6, "w": 24, "x": 0, "y": 6 },
            "targets": [
              { "refId": "Start", "format": "table", "instant": true, "expr": "air_cloud_agent_start_timestamp_seconds{project=\"sangxia-ai\"} * 1000" },
              { "refId": "End", "format": "table", "instant": true, "expr": "air_cloud_agent_last_active_timestamp_seconds{project=\"sangxia-ai\"} * 1000" }
            ]
          },
          {
            "id": 3,
            "type": "timeseries",
            "title": "Air Cloud CPU Usage (%)",
            "gridPos": { "h": 8, "w": 8, "x": 0, "y": 12 },
            "targets": [{ "refId": "A", "expr": "100 - (avg by (host) (rate(node_cpu_seconds_total{project=\"sangxia-ai\", mode=\"idle\"}[1m])) * 100)", "legendFormat": "CPU % ({{host}})" }]
          },
          {
            "id": 4,
            "type": "timeseries",
            "title": "Air Cloud Memory Used (Bytes)",
            "gridPos": { "h": 8, "w": 8, "x": 8, "y": 12 },
            "targets": [{ "refId": "A", "expr": "node_memory_MemTotal_bytes{project=\"sangxia-ai\"} - node_memory_MemAvailable_bytes{project=\"sangxia-ai\"}", "legendFormat": "Used RAM ({{host}})" }]
          },
          {
            "id": 5,
            "type": "timeseries",
            "title": "Air Cloud Network Traffic (RX / TX Bps)",
            "gridPos": { "h": 8, "w": 8, "x": 16, "y": 12 },
            "targets": [
              { "refId": "RX", "expr": "sum by (host) (rate(node_network_receive_bytes_total{project=\"sangxia-ai\", device!~\"lo|docker.*\"}[1m]))", "legendFormat": "RX ({{host}})" },
              { "refId": "TX", "expr": "-sum by (host) (rate(node_network_transmit_bytes_total{project=\"sangxia-ai\", device!~\"lo|docker.*\"}[1m]))", "legendFormat": "TX ({{host}})" }
            ]
          }
        ]
      }
    }'; then
    echo "[air-startup] WARNING: Failed to register Grafana dashboard at ${GRAFANA_URL%/}:" >&2
    cat "$DASHBOARD_RESP" >&2
    echo >&2
  fi
  rm -f "$DASHBOARD_RESP"
else
  echo "[air-startup] NOTE: GRAFANA_URL / GRAFANA_SERVICE_TOKEN not set; skipping dashboard registration (uid sangxia-air-cloud-monitor)." >&2
fi
