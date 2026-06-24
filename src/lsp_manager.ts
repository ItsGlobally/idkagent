import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig, type AgentConfig, type LspToolConfig } from './config.js';

// ─── LSP Definitions ─────────────────────────────────────────

export interface LspDefinition {
  name: string;
  displayName: string;
  bin: string;
  description: string;
  /** How to check if it's installed */
  checkCommand: string;
  /** Shell command to install it (used by install-lsp.sh) */
  installCommand: string;
  /** URL to download page / docs */
  url: string;
}

const KNOWN_LSPS: LspDefinition[] = [
  {
    name: 'typescript',
    displayName: 'TypeScript (tsc)',
    bin: 'tsc',
    description: 'TypeScript compiler diagnostics via tsc --noEmit',
    checkCommand: 'tsc --version',
    installCommand: 'npm install -g typescript',
    url: 'https://www.npmjs.com/package/typescript',
  },
  {
    name: 'java',
    displayName: 'Java (JDT LS)',
    bin: 'jdtls',
    description: 'Eclipse JDT Language Server for Java diagnostics',
    checkCommand: 'jdtls --version 2>/dev/null || echo "not_found"',
    installCommand: [
      'JDTLS_URL="https://download.eclipse.org/jdtls/snapshots/jdt-language-server-1.54.0-202511200503.tar.gz"',
      'JDTLS_DIR="$HOME/jdtls"',
      'BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"',
      'if [ -f "$BIN_DIR/jdtls" ]; then',
      '  echo "   ✅ Already installed."',
      '  exit 0',
      'fi',
      'echo "   ⏳ Downloading JDT LS..."',
      'mkdir -p "$JDTLS_DIR" "$BIN_DIR"',
      'curl -#L "$JDTLS_URL" | tar xz -C "$JDTLS_DIR" --strip-components=1 2>&1 | sed \'s/^/   /\'',
      'JDTLS_BIN="$(find "$JDTLS_DIR" -name "jdtls" -type f | head -1)"',
      'if [ -z "$JDTLS_BIN" ]; then',
      '  echo "   ❌ Failed to locate jdtls binary after extraction."',
      '  exit 1',
      'fi',
      'ln -sf "$JDTLS_BIN" "$BIN_DIR/jdtls"',
      'chmod +x "$BIN_DIR/jdtls"',
      'echo "   ✅ JDT LS installed to $JDTLS_DIR, symlinked to $BIN_DIR/jdtls"',
    ].join('\n    '),
    url: 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-1.54.0-202511200503.tar.gz',
  },
];

export function getKnownLsps(): LspDefinition[] {
  return KNOWN_LSPS;
}

export function getLspByName(name: string): LspDefinition | undefined {
  return KNOWN_LSPS.find(l => l.name === name.toLowerCase());
}

// ─── Status Checks ───────────────────────────────────────────

export function isLspInstalled(lsp: LspDefinition): boolean {
  try {
    execSync(lsp.checkCommand, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function getLspConfig(config: AgentConfig, name: string): LspToolConfig | undefined {
  const lsp = getLspByName(name);
  if (!lsp) return undefined;
  return (config.lsp as Record<string, LspToolConfig | undefined>)[lsp.name];
}

export function isLspEnabled(config: AgentConfig, name: string): boolean {
  const cfg = getLspConfig(config, name);
  return cfg?.enabled ?? false;
}

// ─── Config Updates ──────────────────────────────────────────

export function setLspEnabled(config: AgentConfig, name: string, enabled: boolean): void {
  const lsp = getLspByName(name);
  if (!lsp) return;
  const lspMap = config.lsp as Record<string, LspToolConfig>;
  if (!lspMap[lsp.name]) {
    lspMap[lsp.name] = { bin: lsp.bin, enabled };
  } else {
    lspMap[lsp.name].enabled = enabled;
  }
}

// ─── Install / Uninstall via Script ─────────────────────────

export function installLsp(lsp: LspDefinition): { success: boolean; output: string } {
  if (lsp.name === 'java') {
    // Auto-install JDT LS by downloading and extracting
    const jdtlsUrl = lsp.url;
    const jdtlsDir = path.join(os.homedir(), 'jdtls');
    const binDir = process.env.XDG_BIN_HOME || path.join(os.homedir(), '.local', 'bin');
    const jdtlsBin = path.join(binDir, 'jdtls');

    // Check if already installed
    if (fs.existsSync(jdtlsBin)) {
      return { success: true, output: `✅ ${lsp.displayName} already installed at ${jdtlsBin}` };
    }

    try {
      // Ensure directories exist
      fs.mkdirSync(jdtlsDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });

      // Create a temp dir for download
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-'));
      const tarball = path.join(tmpDir, 'jdtls.tar.gz');

      console.log(`   ⏳ Downloading JDT LS from ${jdtlsUrl}...`);
      execSync(`curl -#SLo "${tarball}" "${jdtlsUrl}"`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000, // 5 min for download
      });

      console.log(`   ⏳ Extracting...`);
      execSync(`tar xzf "${tarball}" -C "${jdtlsDir}" --strip-components=1`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });

      // Find the jdtls script inside the extracted folder
      const findResult = execSync(`find "${jdtlsDir}" -name "jdtls" -type f | head -1`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      }).trim();

      if (!findResult) {
        // Cleanup tmp
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { success: false, output: `❌ Failed to locate jdtls binary after extraction.` };
      }

      // Create symlink
      if (fs.existsSync(jdtlsBin)) {
        fs.unlinkSync(jdtlsBin);
      }
      fs.symlinkSync(findResult, jdtlsBin);
      fs.chmodSync(jdtlsBin, 0o755);

      // Cleanup tmp
      fs.rmSync(tmpDir, { recursive: true, force: true });

      return {
        success: true,
        output: `✅ ${lsp.displayName} installed.\n   Location: ${jdtlsDir}\n   Symlink:  ${jdtlsBin}\n   Make sure ${binDir} is in your PATH.`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: (err.stderr?.toString() || err.stdout?.toString() || err.message || 'Unknown error').substring(0, 1000),
      };
    }
  }

  if (!lsp.installCommand) {
    return { success: false, output: `No install command available for ${lsp.displayName}.` };
  }

  try {
    const output = execSync(lsp.installCommand, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { success: true, output: output.trim() || `✅ ${lsp.displayName} installed successfully.` };
  } catch (err: any) {
    return {
      success: false,
      output: err.stderr?.toString() || err.stdout?.toString() || err.message || 'Unknown error',
    };
  }
}

export function uninstallLsp(lsp: LspDefinition): { success: boolean; output: string } {
  if (lsp.name === 'java') {
    const jdtlsDir = path.join(os.homedir(), 'jdtls');
    const binDir = process.env.XDG_BIN_HOME || path.join(os.homedir(), '.local', 'bin');
    const jdtlsBin = path.join(binDir, 'jdtls');

    let removed = 0;

    // Remove symlink
    if (fs.existsSync(jdtlsBin)) {
      fs.unlinkSync(jdtlsBin);
      removed++;
    }

    // Remove extracted directory
    if (fs.existsSync(jdtlsDir)) {
      fs.rmSync(jdtlsDir, { recursive: true, force: true });
      removed++;
    }

    if (removed > 0) {
      return { success: true, output: `✅ ${lsp.displayName} uninstalled.\n   Removed: ${jdtlsDir}\n   Removed: ${jdtlsBin}` };
    }
    return { success: true, output: `✅ ${lsp.displayName} was not installed.` };
  }

  let uninstallCmd: string;
  if (lsp.name === 'typescript') {
    uninstallCmd = 'npm uninstall -g typescript';
  } else {
    return { success: false, output: `Auto-uninstall not supported for ${lsp.displayName}. Please remove it manually.` };
  }

  try {
    const output = execSync(uninstallCmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { success: true, output: output.trim() || `✅ ${lsp.displayName} uninstalled.` };
  } catch (err: any) {
    return {
      success: false,
      output: err.stderr?.toString() || err.stdout?.toString() || err.message || 'Unknown error',
    };
  }
}

// ─── Generate install script ─────────────────────────────────

export function getInstallScriptContent(): string {
  const lsps = KNOWN_LSPS;
  const parts: string[] = [];
  parts.push(`#!/usr/bin/env bash`);
  parts.push(`# ─── idkagent LSP Auto-Installer ─────────────────────`);
  parts.push(`# Installs all LSP servers used by the agent.`);
  parts.push(``);
  parts.push(`set -e`);
  parts.push(``);
  parts.push(`echo "🔧 idkagent LSP Auto-Installer"`);
  parts.push(`echo "================================"`);
  parts.push(``);
  parts.push(`INSTALL_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"`);
  parts.push(`BIN_DIR="\${XDG_BIN_HOME:-\$HOME/.local/bin}"`);
  parts.push(``);

  for (const lsp of lsps) {
    parts.push(`# ─── ${lsp.displayName} ───────────────────────────────`);
    parts.push(`echo ""`);
    parts.push(`echo "📦 ${lsp.displayName}"`);
    parts.push(`echo "   ${lsp.description}"`);
    parts.push(`if command -v ${lsp.bin} &>/dev/null; then`);
    parts.push(`  echo "   ✅ Already installed."`);
    if (lsp.installCommand) {
      // For Java, we inline the download logic
      if (lsp.name === 'java') {
        parts.push(`else`);
        parts.push(`  echo "   ⏳ Downloading JDT LS..."`);
        parts.push(`  JDTLS_URL="${lsp.url}"`);
        parts.push(`  JDTLS_DIR="\$HOME/jdtls"`);
        parts.push(`  mkdir -p "\$JDTLS_DIR" "\$BIN_DIR"`);
        parts.push(`  curl -#L "\$JDTLS_URL" | tar xz -C "\$JDTLS_DIR" --strip-components=1`);
        parts.push(`  echo "   ✅ Extracted to \$JDTLS_DIR"`);
        parts.push(`  JDTLS_BIN="\$(find "\$JDTLS_DIR" -name "jdtls" -type f | head -1)"`);
        parts.push(`  if [ -z "\$JDTLS_BIN" ]; then`);
        parts.push(`    echo "   ❌ Failed to locate jdtls binary after extraction."`);
        parts.push(`    exit 1`);
        parts.push(`  fi`);
        parts.push(`  ln -sf "\$JDTLS_BIN" "\$BIN_DIR/jdtls"`);
        parts.push(`  chmod +x "\$BIN_DIR/jdtls"`);
        parts.push(`  echo "   ✅ Symlinked: \$BIN_DIR/jdtls"`);
      } else {
        parts.push(`else`);
        parts.push(`  echo "   ⏳ Installing..."`);
        parts.push(`  ${lsp.installCommand} 2>&1 | sed 's/^/   /'`);
        parts.push(`  echo "   ✅ Installation complete."`);
      }
    }
    parts.push(`fi`);
    parts.push(``);
  }

  parts.push(`echo ""`);
  parts.push(`echo "✅ All LSP servers installed/verified."`);
  parts.push(`echo ""`);
  parts.push(`echo "LSP configuration is in config.yml under 'lsp:'"`);
  parts.push(`echo "Run: idkagent lsp list"`);
  parts.push(``);
  return parts.join('\n');
}
