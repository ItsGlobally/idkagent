#!/usr/bin/env bash
# ─── idkagent LSP Auto-Installer ─────────────────────
# Installs all LSP servers used by the agent.

set -e

echo "🔧 idkagent LSP Auto-Installer"
echo "================================"

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

# ─── TypeScript (tsc) ───────────────────────────────
echo ""
echo "📦 TypeScript (tsc)"
echo "   TypeScript compiler diagnostics via tsc --noEmit"
if command -v tsc &>/dev/null; then
  echo "   ✅ Already installed."
else
  echo "   ⏳ Installing..."
  npm install -g typescript 2>&1 | sed 's/^/   /'
  echo "   ✅ Installation complete."
fi

# ─── Java (JDT LS) ───────────────────────────────
echo ""
echo "📦 Java (JDT LS)"
echo "   Eclipse JDT Language Server for Java diagnostics"
if command -v jdtls &>/dev/null; then
  echo "   ✅ Already installed."
else
  echo "   ⏳ Downloading JDT LS..."
  JDTLS_URL="https://download.eclipse.org/jdtls/snapshots/jdt-language-server-1.54.0-202511200503.tar.gz"
  JDTLS_DIR="$HOME/.idkagent/lsp/jdtls"
  mkdir -p "$JDTLS_DIR" "$BIN_DIR"
  curl -#L "$JDTLS_URL" | tar xz -C "$JDTLS_DIR"
  echo "   ✅ Extracted to $JDTLS_DIR"

  JDTLS_BIN="$(find "$JDTLS_DIR" -name "jdtls" -type f | head -1)"
  if [ -z "$JDTLS_BIN" ]; then
    echo "   ❌ Failed to locate jdtls binary after extraction."
    echo "   Directory contents:"
    find "$JDTLS_DIR" -maxdepth 3 -type f | head -20 | sed 's/^/     /'
    exit 1
  fi

  ln -sf "$JDTLS_BIN" "$BIN_DIR/jdtls"
  chmod +x "$BIN_DIR/jdtls"
  echo "   ✅ Symlinked: $BIN_DIR/jdtls → $JDTLS_BIN"
  echo ""
  echo "   ℹ️  Make sure $BIN_DIR is in your PATH."
fi

echo ""
echo "✅ All LSP servers installed/verified."
echo ""
echo "LSP configuration is in config.yml under 'lsp:'"
echo "Run: idkagent lsp list"
