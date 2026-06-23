#!/usr/bin/env bash
set -euo pipefail

# ─── idkagent Installation Script ──────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ItsGlobally/idkagent/main/install.sh | bash
#   or
#   ./install.sh

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
    err "git is not installed."
    echo "  Install git via your package manager, then re-run the script."
    exit 1
  fi
  log "git $(git --version | cut -d' ' -f3)"
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
      err "Directory ${repo_dir} already exists but is not a git repository."
      echo "  Please remove or rename it, then re-run the script."
      exit 1
    fi
    mkdir -p "$(dirname "$repo_dir")"
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

# ─── Show Completion Message ──────────────────────────────────

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

  printf "${BOLD}🚀 Run idkagent:${RESET}\n"
  printf "\n"
  printf "  ${CYAN}cd %s && npm start chat${RESET}\n" "$repo_dir"
  printf "  ${CYAN}cd %s && npm start gateway start${RESET}\n" "$repo_dir"
  printf "\n"
  printf "  ${DIM}# Or use npm run dev for development mode${RESET}\n"
  printf "  ${CYAN}cd %s && npm run dev -- chat${RESET}\n" "$repo_dir"
  printf "\n"
  printf "  ${DIM}# To configure your API keys:${RESET}\n"
  printf "  ${CYAN}nano %s/config.yml${RESET}\n" "$data_dir"
  printf "\n"

  printf "${BOLD}⚙️  Config Location:${RESET} %s/config.yml\n" "$data_dir"
  printf "\n"
}

# ─── Main ─────────────────────────────────────────────────────

main() {
  printf "${CYAN}${BOLD}╔═══════════════════════════════════════════╗${RESET}\n"
  printf "${CYAN}${BOLD}║      🤖 idkagent Install Script v2.0     ║${RESET}\n"
  printf "${CYAN}${BOLD}╚═══════════════════════════════════════════╝${RESET}\n"
  printf "\n"

  # Force installation to ~/.idkagent/
  local base_dir="$HOME/.idkagent"
  local repo_dir="$base_dir/$REPO_DIRNAME"

  check_prereqs
  setup_repo "$repo_dir"

  # Run npm install and build from the repo dir
  cd "$repo_dir"
  install_deps
  build_project

  # Setup data directories in the base dir
  setup_dirs "$base_dir"
  init_config "$base_dir" "$repo_dir"

  show_usage "$base_dir" "$repo_dir"
}

main "$@"
