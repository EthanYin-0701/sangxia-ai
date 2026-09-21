#!/usr/bin/env bash
#
# 把本仓库 skills/ 下的技能安装到 ZhenTe 的全局技能目录，让任意 cwd 的
# ZhenTe session 都能发现它们（ACP 客户端、TUI 都适用）。
#
# 用法:
#   scripts/install-skills.sh                 # 装到 ~/.config/zhente/skills
#   scripts/install-skills.sh --dry-run       # 只打印要做什么
#   scripts/install-skills.sh --force         # 覆盖已存在的同名技能
#   scripts/install-skills.sh --skill deepseek-usage
#   scripts/install-skills.sh --target /path/to/skills
#   ZHENTE_SKILLS_DIR=/path/to/skills scripts/install-skills.sh
#
# 注意（装完仍然"看不见"技能时先看这三条）:
#   1. 项目的 zhente.config.json 若设置了 skills.dirs（非空），它会**替换**默认目录
#      （默认 = <cwd>/skills + ~/.config/zhente/skills）——必须把全局目录显式列进去。
#   2. 技能清单在 session/new 时扫描一次，装完要**新开会话**才生效。
#   3. skills.enabled 必须为 true（默认 true）。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/skills"
TARGET_DIR="${ZHENTE_SKILLS_DIR:-$HOME/.config/zhente/skills}"
DRY_RUN=0
FORCE=0
ONLY=""

die() { echo "error: $*" >&2; exit 1; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --skill) ONLY="${2:-}"; [ -n "$ONLY" ] || die "--skill 需要一个技能名"; shift ;;
    --target) TARGET_DIR="${2:-}"; [ -n "$TARGET_DIR" ] || die "--target 需要一个目录"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
  shift
done

[ -d "$SOURCE_DIR" ] || die "找不到源码技能目录: $SOURCE_DIR"
[ -n "$TARGET_DIR" ] || die "目标目录为空"

echo "源:   $SOURCE_DIR"
echo "目标: $TARGET_DIR"
[ "$DRY_RUN" = 1 ] && echo "模式: dry-run（不会写任何文件）"
echo

installed=0
skipped=0
for src in "$SOURCE_DIR"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  # ONLY 过滤必须排在 SKILL.md 检查**之前**：否则 `--skill <name>` 指向一个缺 SKILL.md 的目录时，
  # 只会走"跳过"分支（skipped 变成 1），末尾的 die 条件（installed=0 且 skipped=0）不再成立，
  # 脚本会以 exit 0 打印"安装 0 个，跳过 1 个"——用户以为装上了。
  # 顺带好处：指定单个技能时，别的目录（含坏目录）不再产生无关的"跳过"噪声。
  if [ -n "$ONLY" ] && [ "$name" != "$ONLY" ]; then continue; fi

  if [ ! -f "$src/SKILL.md" ]; then
    if [ -n "$ONLY" ]; then
      die "技能 '$ONLY' 存在（${src}）但缺少 SKILL.md，无法安装"
    fi
    echo "跳过 ${name}（没有 SKILL.md）"
    skipped=$((skipped + 1))
    continue
  fi

  dest="$TARGET_DIR/$name"
  if [ -e "$dest" ] && [ "$FORCE" != 1 ]; then
    echo "已存在，未覆盖: ${dest}（要覆盖加 --force）"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] rm -rf $dest && cp -R $src $dest"
    installed=$((installed + 1))
    continue
  fi

  mkdir -p "$TARGET_DIR"
  rm -rf "$dest"
  cp -R "$src" "$dest"
  echo "已安装: $name -> $dest"
  installed=$((installed + 1))
done

if [ -n "$ONLY" ] && [ "$installed" = 0 ] && [ "$skipped" = 0 ]; then
  die "源码技能目录里没有名为 '$ONLY' 的技能"
fi

echo
echo "完成: 安装 $installed 个，跳过 $skipped 个"
cat <<'NOTE'

后续手动确认（脚本不会改你的配置文件）:
  1. 新开会话——技能清单只在 session/new 时扫描一次。
  2. 若目标项目的 zhente.config.json 设了 skills.dirs，把全局目录加进去，例如：
       { "skills": { "enabled": true,
                     "dirs": ["skills", ".claude/skills", "$HOME/.config/zhente/skills"] } }
     （dirs 非空会替换默认目录；同名技能先到先得，故全局目录建议排在最后。）
  3. TUI 场景无需额外配置（技能发现与 MCP 无关，纯本地技能可直接用）。
NOTE
