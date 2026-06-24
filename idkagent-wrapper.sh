#!/usr/bin/env bash
# ─── idkagent wrapper — 從任意位置呼叫 ─────────────────────────
# 此檔案由 install.sh 自動放置到 PATH 中。
# 若要手動安裝：ln -sf /path/to/idkagent/idkagent-wrapper.sh ~/.local/bin/idkagent

# 解析 symlink 以找到實際的專案目錄（即使透過 PATH symlink 執行）
REAL_SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(cd "$(dirname "$REAL_SCRIPT")" && pwd)"

# 切換到專案根目錄，確保 config.yml 和 workspace/ 路徑正確
cd "$PROJECT_DIR"

# ─── 找到 node 可執行檔（支援 nvm 等非標準路徑） ─────────────
find_node() {
  # 1. 先試 PATH
  if command -v node &>/dev/null; then
    command -v node
    return 0
  fi
  # 2. 嘗試常見的 nvm 安裝路徑
  local NVM_NODE="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [[ -d "$NVM_NODE" ]]; then
    local BEST=""
    for ver in "$NVM_NODE"/*/bin/node; do
      if [[ -x "$ver" ]]; then
        BEST="$ver"
      fi
    done
    if [[ -n "$BEST" ]]; then
      echo "$BEST"
      return 0
    fi
  fi
  # 3. 最後試系統預設路徑
  if [[ -x /usr/local/bin/node ]]; then
    echo /usr/local/bin/node
    return 0
  fi
  if [[ -x /usr/bin/node ]]; then
    echo /usr/bin/node
    return 0
  fi
  return 1
}

NODE_BIN="$(find_node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ idkagent: 找不到 node 可執行檔。請確認 Node.js 已安裝並在 PATH 中。" >&2
  exit 1
fi

# 優先使用編譯後的版本，否則 fallback 到 tsx dev 模式
if [[ -f "$PROJECT_DIR/dist/index.js" ]]; then
  exec "$NODE_BIN" "$PROJECT_DIR/dist/index.js" "$@"
elif command -v tsx &>/dev/null; then
  exec tsx "$PROJECT_DIR/src/index.ts" "$@"
else
  echo "❌ idkagent: 找不到 dist/index.js 也找不到 tsx。請先執行 npm run build 或 npm install。" >&2
  exit 1
fi
