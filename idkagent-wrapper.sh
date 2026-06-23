#!/usr/bin/env bash
# ─── idkagent wrapper — 從任意位置呼叫 ─────────────────────────
# 此檔案由 install.sh 自動放置到 PATH 中。
# 若要手動安裝：ln -sf /path/to/idkagent/idkagent-wrapper.sh ~/.local/bin/idkagent

# 解析 symlink 以找到實際的專案目錄（即使透過 PATH symlink 執行）
REAL_SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(cd "$(dirname "$REAL_SCRIPT")" && pwd)"

# 切換到專案根目錄，確保 config.yml 和 workspace/ 路徑正確
cd "$PROJECT_DIR"

# 優先使用編譯後的版本，否則 fallback 到 tsx dev 模式
if [[ -f "$PROJECT_DIR/dist/index.js" ]]; then
  exec node "$PROJECT_DIR/dist/index.js" "$@"
elif command -v tsx &>/dev/null; then
  exec tsx "$PROJECT_DIR/src/index.ts" "$@"
else
  echo "❌ idkagent: 找不到 dist/index.js 也找不到 tsx。請先執行 npm run build 或 npm install。" >&2
  exit 1
fi
