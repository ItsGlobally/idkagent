#!/usr/bin/env bash
set -euo pipefail

# ─── idkagent Installation Script ──────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ItsGlobally/idkagent/main/install.sh | bash
#   or
#   ./install.sh [--dir <path>] [--no-path]

REPO="https://github.com/ItsGlobally/idkagent.git"
BRANCH="main"
REPO_DIRNAME="idkagent"

# ─── Colors ────────────────────────────────────────────────────

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

# ─── Prerequisites Check ──────────────────────────────────────

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

# ─── Clone / Update Repository ────────────────────────────────

setup_repo() {
  local repo_dir="$1"

  if [[ -d "$repo_dir/.git" ]]; then
    step "Updating existing repository in ${repo_dir}..."
    cd "$repo_dir"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
    log "Repository updated to latest commit."
  else
    step "Cloning idkagent into ${repo_dir}..."
    if [[ -d "$repo_dir" ]]; then
      warn "Directory ${repo_dir} already exists but is not a git repository."
      echo "  Either remove it, specify a different path with --dir, or run the script inside the project."
      exit 1
    fi
    git clone --branch "$BRANCH" "$REPO" "$repo_dir"
    cd "$repo_dir"
    log "Repository cloned."
  fi
}

# ─── Install Dependencies ─────────────────────────────────────

install_deps() {
  step "Installing npm dependencies..."
  npm install
  log "Dependencies installed."
}

# ─── Initialize Configuration ─────────────────────────────────

init_config() {
  local data_dir="$1"
  local repo_dir="$2"

  if [[ -f "$data_dir/config.yml" ]]; then
    warn "config.yml already exists at ${data_dir}/config.yml. Skipping initialization."
    info "  Edit config.yml to set your API keys if needed."
    return
  fi

  # Run config init from the repo dir (it creates config in parent data dir)
  cd "$repo_dir"
  npx tsx src/index.ts config init 2>/dev/null || true

  # If config.yml was created in the repo dir, move it to the data dir
  if [[ -f config.yml ]]; then
    mv config.yml "$data_dir/config.yml"
    log "Default config.yml created at ${data_dir}/config.yml."
  elif [[ -f "$data_dir/config.yml" ]]; then
    log "Default config.yml created at ${data_dir}/config.yml."
  else
    warn "Could not generate config.yml automatically."
  fi

  info "  You can edit config.yml to configure:"
  info "    • LLM providers (Gemini, OpenAI-compatible)"
  info "    • API keys and models"
  info "    • Discord bot token (if using Discord gateway)"
  info "    • Logging preferences"
  info "    • Web search provider"
}

# ─── Setup Data Directories ───────────────────────────────────

setup_dirs() {
  local data_dir="$1"

  step "Setting up data directories in ${data_dir}..."
  mkdir -p "$data_dir/.sessions" "$data_dir/credentials"
  touch "$data_dir/credentials/secrets.json" 2>/dev/null || true
  touch "$data_dir/MEMORY.md" "$data_dir/AGENT.md" "$data_dir/SOUL.md" 2>/dev/null || true
  log "Data directories ready at ${data_dir}."
}

# ─── Build Project ────────────────────────────────────────────

build_project() {
  step "Building project..."
  npm run build 2>/dev/null && log "Build successful." || warn "Build failed — you can still run with 'npm run dev'."
}

# ─── Install Wrapper into PATH ────────────────────────────────

install_wrapper() {
  local repo_dir="$1"

  step "Installing 'idkagent' wrapper into PATH..."

  # Prefer ~/.local/bin, fallback to ~/bin
  local bin_dir="$HOME/.local/bin"
  if [[ ! -d "$bin_dir" ]]; then
    mkdir -p "$bin_dir"
  fi

  # If ~/bin exists and ~/.local/bin is not in PATH, use ~/bin instead
  if [[ -d "$HOME/bin" ]] && ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    bin_dir="$HOME/bin"
  fi

  local wrapper_src="$repo_dir/idkagent-wrapper.sh"
  local wrapper_dst="$bin_dir/idkagent"

  if [[ ! -f "$wrapper_src" ]]; then
    warn "Wrapper script not found at ${wrapper_src}. Skipping."
    return
  fi

  chmod +x "$wrapper_src"
  ln -sf "$wrapper_src" "$wrapper_dst"
  log "Wrapper linked: ${wrapper_dst} → ${wrapper_src}"

  # Ensure the target directory is in PATH
  add_to_path "$bin_dir"
}

# ─── Ensure Directory is in PATH ──────────────────────────────

add_to_path() {
  local dir="$1"

  # Skip if already in PATH
  if echo "$PATH" | tr ':' '\n' | grep -qx "$dir"; then
    return
  fi

  local shell_config=""
  case "${SHELL-}" in
    */zsh) shell_config="$HOME/.zshrc" ;;
    */bash) shell_config="$HOME/.bashrc" ;;
  esac

  if [[ -n "$shell_config" ]]; then
    # Avoid duplicate entries
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

# ─── Show Usage / Completion Message ──────────────────────────

show_usage() {
  local data_dir="$1"
  local repo_dir="$2"
  printf "\n"
  printf "${MAGENTA}${BOLD}╔═══════════════════════════════════════════╗${RESET}\n"
  printf "${MAGENTA}${BOLD}║     🎉 idkagent installation complete!   ║${RESET}\n"
  printf "${MAGENTA}${BOLD}╚═══════════════════════════════════════════╝${RESET}\n"
  printf "\n"

  printf "${BOLD}📂 Data Directory:${RESET} ${data_dir}\n"
  printf "${BOLD}📂 Repository:${RESET}     ${repo_dir}\n"
  printf "\n"

  printf "${BOLD}🚀 Quick Start:${RESET}\n"
  printf "\n"
  printf "  ${CYAN}# Run idkagent from anywhere${RESET}\n"
  printf "  idkagent chat\n"
  printf "  idkagent gateway start\n"
  printf "  idkagent help\n"
  printf "\n"
  printf "  ${CYAN}# Edit the configuration (set your API keys)${RESET}\n"
  printf "  nano %s/config.yml\n" "$data_dir"
  printf "\n"
  printf "  ${CYAN}# Specify a Gemini provider${RESET}\n"
  printf "  idkagent chat --provider gemini --model gemini-2.5-flash\n"
  printf "\n"

  printf "${BOLD}📋 Available Commands:${RESET}\n"
  printf "\n"
  printf "  ${DIM}idkagent chat              ${RESET}  Start interactive CLI chat\n"
  printf "  ${DIM}idkagent gateway start     ${RESET}  Start Discord bot gateway\n"
  printf "  ${DIM}idkagent config init       ${RESET}  Create default config.yml\n"
  printf "  ${DIM}idkagent config show       ${RESET}  Display current configuration\n"
  printf "  ${DIM}idkagent help              ${RESET}  Show help message\n"
  printf "\n"

  printf "${BOLD}⚙️  Config Location:${RESET} %s/config.yml\n" "$data_dir"
  printf "${BOLD}🔗  Wrapper Location:${RESET} ~/.local/bin/idkagent\n"
  printf "\n"
}

# ─── Main ─────────────────────────────────────────────────────

main() {
  printf "${CYAN}${BOLD}╔═══════════════════════════════════════════╗${RESET}\n"
  printf "${CYAN}${BOLD}║      🤖 idkagent Install Script v1.2     ║${RESET}\n"
  printf "${CYAN}${BOLD}╚═══════════════════════════════════════════╝${RESET}\n"
  printf "\n"

  # Parse arguments
  local base_dir=""
  local no_path=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)
        base_dir="$2"
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

  # Determine directories
  #  base_dir  = data root (e.g. ~/.idkagent/)
  #  repo_dir  = git clone location (e.g. ~/.idkagent/idkagent/)
  local repo_dir=""

  if [[ -z "$base_dir" ]]; then
    # If already inside an idkagent git repo, use parent as base
    if [[ -d ".git" ]] && git remote get-url origin 2>/dev/null | grep -q "idkagent" 2>/dev/null; then
      base_dir="$(cd .. && pwd)"
      repo_dir="$(pwd)"
      info "Detected existing idkagent repository at ${repo_dir}"
    else
      base_dir="$HOME/.idkagent"
      repo_dir="$base_dir/$REPO_DIRNAME"
    fi
  else
    repo_dir="$base_dir/$REPO_DIRNAME"
  fi

  check_prereqs
  setup_repo "$repo_dir"

  # Run npm install and build from the repo dir
  cd "$repo_dir"
  install_deps
  build_project

  # Setup data directories in the base dir
  setup_dirs "$base_dir"
  init_config "$base_dir" "$repo_dir"

  if [[ "$no_path" == false ]]; then
    install_wrapper "$repo_dir"
  else
    info "Skipping PATH setup (--no-path)."
    info "  To manually install the wrapper:"
    info "    ln -sf ${repo_dir}/idkagent-wrapper.sh ~/.local/bin/idkagent"
    info "    export PATH=\"\$PATH:~/.local/bin\""
  fi

  show_usage "$base_dir" "$repo_dir"
}

main "$@"
