#!/usr/bin/env bash
set -euo pipefail

# ─── idkagent 安裝腳本 ─────────────────────────────────────────
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/ItsGlobally/idkagent/main/install.sh | bash
#   或
#   ./install.sh [--dir <path>] [--no-path]

REPO="https://github.com/ItsGlobally/idkagent.git"
BRANCH="main"

# ─── 顏色 ─────────────────────────────────────────────────────

RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
MAGENTA='\033[35m'

log()  { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
err()  { printf "${RED}✗${RESET} %s\n" "$1"; }
step() { printf "\n${CYAN}${BOLD}▶ %s${RESET}\n" "$1"; }
info() { printf "${DIM}%s${RESET}\n" "$1"; }

# ─── 前置檢查 ─────────────────────────────────────────────────

check_prereqs() {
  step "Checking prerequisites..."

  if ! command -v node &>/dev/null; then
    err "Node.js is not installed."
    echo "  Install it from: https://nodejs.org/ (v22+ recommended)"
    echo "  Or use nvm: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash && nvm install 22"
    exit 1
  fi
  log "Node.js $(node -v)"

  if ! command -v npm &>/dev/null; then
    err "npm is not installed."
    exit 1
  fi
  log "npm $(npm -v)"

  if ! command -v git &>/dev/null; then
    warn "git is not installed — skipping repository clone. Run this script inside the project directory."
  else
    log "git $(git --version | cut -d' ' -f3)"
  fi
}

# ─── 取得/更新程式碼 ──────────────────────────────────────────

setup_repo() {
  local target_dir="$1"

  if [[ -d "$target_dir/.git" ]]; then
    step "Updating existing repository in ${target_dir}..."
    cd "$target_dir"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
    log "Repository updated to latest commit."
  else
    step "Cloning idkagent into ${target_dir}..."
    if [[ -d "$target_dir" ]]; then
      warn "Directory ${target_dir} already exists but is not a git repository."
      echo "  Either remove it, specify a different path with --dir, or run the script inside the project."
      exit 1
    fi
    git clone --branch "$BRANCH" "$REPO" "$target_dir"
    cd "$target_dir"
    log "Repository cloned."
  fi
}

# ─── 安裝依賴 ─────────────────────────────────────────────────

install_deps() {
  step "Installing npm dependencies..."
  npm install
  log "Dependencies installed."
}

# ─── 初始化設定檔 ─────────────────────────────────────────────

init_config() {
  step "Setting up configuration..."

  if [[ -f config.yml ]]; then
    warn "config.yml already exists. Skipping initialization."
    info "  Edit config.yml to set your API keys if needed."
    return
  fi

  npx tsx src/index.ts config init 2>/dev/null || true

  if [[ -f config.yml ]]; then
    log "Default config.yml created."
  else
    # 若 config init 沒有輸出名稱 config.yml，手動建立
    warn "Could not generate config.yml automatically."
  fi

  info "  You can edit config.yml to configure:"
  info "    • LLM providers (Gemini, OpenAI-compatible)"
  info "    • API keys and models"
  info "    • Discord bot token (if using Discord gateway)"
  info "    • Logging preferences"
}

# ─── 建立 workspace 目錄 ──────────────────────────────────────

setup_workspace() {
  step "Setting up workspace..."
  mkdir -p workspace/.sessions workspace/credentials
  touch workspace/credentials/secrets.json 2>/dev/null || true
  log "Workspace directories ready."
}

# ─── 編譯 ─────────────────────────────────────────────────────

build_project() {
  step "Building project..."
  npm run build 2>/dev/null && log "Build successful." || warn "Build failed — you can still run with 'npm run dev'."
}

# ─── 安裝 Wrapper 到 PATH ────────────────────────────────────

install_wrapper() {
  local project_dir="$1"

  step "Installing 'idkagent' wrapper into PATH..."

  # 目標目錄：優先 ~/.local/bin，fallback ~/bin
  local bin_dir="$HOME/.local/bin"
  if [[ ! -d "$bin_dir" ]]; then
    mkdir -p "$bin_dir"
  fi

  # 如果 ~/bin 存在且 ~/.local/bin 不在 PATH 中，改用 ~/bin
  if [[ -d "$HOME/bin" ]] && ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    bin_dir="$HOME/bin"
  fi

  local wrapper_src="$project_dir/idkagent-wrapper.sh"
  local wrapper_dst="$bin_dir/idkagent"

  if [[ ! -f "$wrapper_src" ]]; then
    warn "Wrapper script not found at ${wrapper_src}. Skipping."
    return
  fi

  chmod +x "$wrapper_src"
  ln -sf "$wrapper_src" "$wrapper_dst"
  log "Wrapper linked: ${wrapper_dst} → ${wrapper_src}"

  # 確保目標目錄在 PATH 中
  add_to_path "$bin_dir"
}

# ─── 確保目錄在 PATH ──────────────────────────────────────────

add_to_path() {
  local dir="$1"

  # 如果已經在 PATH 中則跳過
  if echo "$PATH" | tr ':' '\n' | grep -qx "$dir"; then
    return
  fi

  local shell_config=""
  case "${SHELL-}" in
    */zsh) shell_config="$HOME/.zshrc" ;;
    */bash) shell_config="$HOME/.bashrc" ;;
  esac

  if [[ -n "$shell_config" ]]; then
    # 避免重複添加
    if ! grep -q "export PATH=\"\$PATH:$dir\"" "$shell_config" 2>/dev/null; then
      printf "\n# Added by idkagent install script\n" >> "$shell_config"
      printf "export PATH=\"\$PATH:%s\"\n" "$dir" >> "$shell_config"
      log "Added ${dir} to PATH in ${shell_config}"
      info "  Restart your shell or run: source ${shell_config}"
    fi
  else
    warn "Unknown shell (${SHELL}). Add the following to your shell config:"
    info "  export PATH=\"\$PATH:${dir}\""
  fi
}

# ─── 顯示使用說明 ─────────────────────────────────────────────

show_usage() {
  local dir="$1"
  printf "\n"
  printf "${MAGENTA}${BOLD}╔═══════════════════════════════════════════╗${RESET}\n"
  printf "${MAGENTA}${BOLD}║       🎉 idkagent 安裝完成！             ║${RESET}\n"
  printf "${MAGENTA}${BOLD}╚═══════════════════════════════════════════╝${RESET}\n"
  printf "\n"

  printf "${BOLD}📂 專案位置:${RESET} ${dir}\n"
  printf "\n"

  printf "${BOLD}🚀 快速開始:${RESET}\n"
  printf "\n"
  printf "  ${CYAN}# 從任意位置執行 idkagent${RESET}\n"
  printf "  idkagent chat\n"
  printf "  idkagent gateway start\n"
  printf "  idkagent help\n"
  printf "\n"
  printf "  ${CYAN}# 或在專案目錄內用 npm 腳本${RESET}\n"
  printf "  cd %s\n" "$dir"
  printf "\n"
  printf "  ${CYAN}# 編輯設定檔 (填入你的 API Key)${RESET}\n"
  printf "  nano %s/config.yml\n" "$dir"
  printf "\n"
  printf "  ${CYAN}# 指定 Gemini 提供者${RESET}\n"
  printf "  idkagent chat --provider gemini --model gemini-2.5-flash\n"
  printf "\n"

  printf "${BOLD}📋 可用命令:${RESET}\n"
  printf "\n"
  printf "  ${DIM}idkagent chat              ${RESET} 啟動 CLI 互動模式\n"
  printf "  ${DIM}idkagent gateway start     ${RESET} 啟動 Discord 閘道\n"
  printf "  ${DIM}idkagent config init       ${RESET} 建立預設設定檔\n"
  printf "  ${DIM}idkagent config show       ${RESET} 顯示當前設定\n"
  printf "  ${DIM}idkagent help              ${RESET} 顯示幫助\n"
  printf "\n"

  printf "${BOLD}⚙️  設定檔位置:${RESET} %s/config.yml\n" "$dir"
  printf "${BOLD}🔗  Wrapper 位置:${RESET} ~/.local/bin/idkagent\n"
  printf "\n"
}

# ─── 主程式 ───────────────────────────────────────────────────

main() {
  printf "${CYAN}${BOLD}╔═══════════════════════════════════════════╗${RESET}\n"
  printf "${CYAN}${BOLD}║        🤖 idkagent 安裝腳本 v1.0        ║${RESET}\n"
  printf "${CYAN}${BOLD}╚═══════════════════════════════════════════╝${RESET}\n"
  printf "\n"

  # 解析參數
  local target_dir=""
  local no_path=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)
        target_dir="$2"
        shift 2
        ;;
      --no-path)
        no_path=true
        shift
        ;;
      --help|-h)
        echo "Usage: ./install.sh [--dir <path>] [--no-path]"
        exit 0
        ;;
      *)
        err "Unknown option: $1"
        echo "Usage: ./install.sh [--dir <path>] [--no-path]"
        exit 1
        ;;
    esac
  done

  # 決定安裝目錄
  if [[ -z "$target_dir" ]]; then
    # 如果已經在 idkagent 目錄內且有 .git，視為已安裝
    if [[ -d ".git" ]] && git remote get-url origin 2>/dev/null | grep -q "idkagent" 2>/dev/null; then
      target_dir="$(pwd)"
      info "Detected existing idkagent repository at ${target_dir}"
    else
      target_dir="$HOME/idkagent"
    fi
  fi

  check_prereqs
  setup_repo "$target_dir"
  install_deps
  init_config
  setup_workspace
  build_project

  if [[ "$no_path" == false ]]; then
    install_wrapper "$target_dir"
  else
    info "Skipping PATH setup (--no-path)."
    info "  To manually install the wrapper:"
    info "    ln -sf ${target_dir}/idkagent-wrapper.sh ~/.local/bin/idkagent"
    info "    export PATH=\"\$PATH:~/.local/bin\""
  fi

  show_usage "$target_dir"
}

main "$@"
