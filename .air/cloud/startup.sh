#!/bin/sh
set -e

echo "[air-startup] Starting Air Cloud environment & agent monitoring..."

# ==============================================================================
# !!!!!! 【手工填写区】如果你没有在 Air 网页端配置环境变量，请直接修改下面引号中的默认值
# ==============================================================================
export PROMETHEUS_REMOTE_WRITE_URL="${PROMETHEUS_REMOTE_WRITE_URL:-}"
export PROMETHEUS_USER="${PROMETHEUS_USER:-}"
export PROMETHEUS_PASSWORD="${PROMETHEUS_PASSWORD:-}"
export GRAFANA_URL="${GRAFANA_URL:-}"
export GRAFANA_SERVICE_TOKEN="${GRAFANA_SERVICE_TOKEN:-}"
export AIR_LLM_MODEL="${AIR_LLM_MODEL:-gemini-default}"

# ==============================================================================
# 以下内容全部自动运行，无需手工修改
# ==============================================================================

# 1. 创建 Alloy 指标目录
TEXTFILE_DIR="/var/lib/alloy/textfile"
sudo mkdir -p "$TEXTFILE_DIR"
sudo chown -R "$(whoami)" "$TEXTFILE_DIR"

# 2. 按需安装 jq, curl, grafana-alloy (幂等)
if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq jq curl ca-certificates gnupg
fi

if ! command -v alloy >/dev/null 2>&1; then
  sudo mkdir -p /etc/apt/keyrings/
  wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor | sudo tee /etc/apt/keyrings/grafana.gpg >/dev/null
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq alloy
fi

# 3. 采集 Air Cloud 自身 Agent (Junie / Claude / Codex) 的运行状态与起止时间
cat << 'EOF' | sudo tee /usr/local/bin/air-agent-collector.sh >/dev/null
#!/bin/sh
OUT_FILE="/var/lib/alloy/textfile/air_agent.prom"
HOST_NAME="$(hostname)"
ENV_BOOT_TS="$(stat -c %Y /proc/1 2>/dev/null || date +%s)"

while true; do
  TMP_FILE="${OUT_FILE}.tmp"
  : > "$TMP_FILE"
  NOW_TS="$(date +%s)"

  # 自动识别当前 Air Cloud 中正在运行的平台 Agent 类型与状态
  AGENT_TYPE="junie"
  LLM_MODEL="${AIR_LLM_MODEL:-default}"
  STATE=0 # 0=IDLE, 1=RUNNING

  if pgrep -f "junie" >/dev/null 2>&1; then
    AGENT_TYPE="junie"
    STATE=1
  elif pgrep -f "claude" >/dev/null 2>&1; then
    AGENT_TYPE="claude-code"
    STATE=1
  elif pgrep -f "codex" >/dev/null 2>&1; then
    AGENT_TYPE="codex"
    STATE=1
  fi

  # 自动从 ~/.junie/sessions/index.jsonl 提取精确的会话 ID、开始/更新时间
  INDEX_FILE="$HOME/.junie/sessions/index.jsonl"
  if [ -f "$INDEX_FILE" ]; then
    LAST_LINE=$(tail -n 1 "$INDEX_FILE" 2>/dev/null || true)
    if [ -n "$LAST_LINE" ]; then
      SID=$(echo "$LAST_LINE" | jq -r '.id // .sessionId // "air-session"')
      START_TS=$(stat -c %W "$INDEX_FILE" 2>/dev/null || echo "$ENV_BOOT_TS")
      [ "$START_TS" -le 0 ] && START_TS="$ENV_BOOT_TS"
      END_TS=$(stat -c %Y "$INDEX_FILE" 2>/dev/null || echo "$NOW_TS")
    fi
  fi

  SID="${SID:-$HOST_NAME}"
  START_TS="${START_TS:-$ENV_BOOT_TS}"
  END_TS="${END_TS:-$NOW_TS}"

  # !!!!!! 如果后续把这个脚本复用到其它项目，可把下面的 project="sangxia-ai" 改成对应项目名
  LABELS="host=\"${HOST_NAME}\",project=\"sangxia-ai\",session_id=\"${SID}\",agent_type=\"${AGENT_TYPE}\",llm_model=\"${LLM_MODEL}\""

  echo "air_cloud_agent_state{${LABELS}} ${STATE}" >> "$TMP_FILE"
  echo "air_cloud_agent_start_timestamp_seconds{${LABELS}} ${START_TS}" >> "$TMP_FILE"
  echo "air_cloud_agent_last_active_timestamp_seconds{${LABELS}} ${END_TS}" >> "$TMP_FILE"

  mv "$TMP_FILE" "$OUT_FILE"
  sleep 5
done
EOF
sudo chmod +x /usr/local/bin/air-agent-collector.sh

if ! pgrep -f "/usr/local/bin/air-agent-collector.sh" >/dev/null 2>&1; then
  nohup /usr/local/bin/air-agent-collector.sh >/tmp/air-agent-collector.log 2>&1 &
fi

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

  if ! pgrep -x "alloy" >/dev/null 2>&1; then
    nohup alloy run /etc/alloy/config.alloy --storage.path=/tmp/alloy-data >/tmp/alloy.log 2>&1 &
  fi
fi

# 5. 自动向已就绪的 Grafana 实例注册/更新 Air Cloud 监控 Dashboard（可选）
if [ -n "${GRAFANA_URL:-}" ] && [ -n "${GRAFANA_SERVICE_TOKEN:-}" ]; then
  curl -sS -X POST "${GRAFANA_URL%/}/api/dashboards/db" \
    -H "Authorization: Bearer ${GRAFANA_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
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
    }' >/dev/null || true
fi