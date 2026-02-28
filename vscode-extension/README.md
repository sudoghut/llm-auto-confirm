# LLM Auto-Confirm (VS Code Extension)

A VS Code extension that auto-confirms permission prompts for LLM coding assistants (Claude Code, Aider, Goose, Codex, etc.). Install and forget — no special setup required.

## Compatibility

### Terminal Mode (default, enabled by default)

Reads terminal output via the VS Code Terminal Shell Integration API, matches prompts with regex, and sends the appropriate response to the specific terminal. This is the primary and most reliable mode.

| Tool | Terminal Command | Prompt Rule | Response | Status |
|------|-----------------|-------------|----------|--------|
| **Claude Code** | `claude` | `(?:Allow\|approve\|Do you want)[\s\S]*?\d+\s*\.?\s*Yes` | `1` | Verified |
| **Claude Code** | `claude` | `Save file to continue[\s\S]*?\d+\s*\.?\s*Yes` | `1` | Verified |
| **Codex CLI** | `codex` | `Allow command\?` | Enter | Should work |
| **Aider** | `aider` | `(?:Y\/?n\|y\/N\|\(y\)es\|\(n\)o)` | `y` | Should work |
| **Goose** | `goose` | Fallback patterns | `1` | Should work |
| **Any CLI tool** | User-configured | User-configured `promptRules` | User-configured | Extensible |

**Key:** Any LLM tool that runs in the terminal and prompts via text output can be supported by adding a `promptRule`.

### WebView Mode (experimental, opt-in, default off)

Calls known VS Code commands exposed by LLM extensions. This mode has significant limitations because most extensions handle permission prompts **inside their webview** and do not expose per-prompt approval commands.

| Extension | VS Code Command | What It Does | Limitation |
|-----------|----------------|--------------|------------|
| **Kilo Code** | `kilo-code.toggleAutoApprove` | Enables auto-approve mode (one-shot) | Toggles a mode, not per-prompt |
| **Kilo Code** | `kilo-code.acceptInput` | Accepts pending input | |
| **Claude Code** | `claude-vscode.acceptProposedDiff` | Accepts editor diff proposals | Does **NOT** approve webview tool-use prompts |
| **Cline** | `cline.approveTask` | Approves pending task | Not verified (not installed) |
| **Roo Code** | `roo-cline.approveTask` | Approves pending task | Not verified (not installed) |
| **Codex** | *(none)* | — | No approval commands exposed |

**Recommendation per tool:**

| Tool | Best Approach |
|------|--------------|
| Claude Code | Use **terminal mode** (`claude` CLI). WebView `acceptProposedDiff` only handles editor diffs. |
| Codex | Use **terminal mode** (`codex` CLI) or Codex's own `--full-auto` flag. WebView has no commands. |
| Kilo Code | **WebView mode** works via `toggleAutoApprove`. |
| Cline / Roo Code | **WebView mode** may work (unverified). |
| Aider / Goose | Use **terminal mode**. These are terminal-only tools. |

## How It Works

### Terminal Mode

1. The extension listens for terminal commands matching LLM tool patterns (e.g., `claude`, `aider`).
2. When detected, it streams the terminal output using VS Code's Terminal Shell Integration API.
3. It matches the output against `promptRules` (checked in order; first match wins).
4. When a prompt matches, it sends the rule's configured response to that specific terminal.
5. Dangerous commands (e.g., `rm -rf /`) are automatically blocked.

**No CDP, no special flags, no mouse/keyboard interference** — it only writes to the target terminal via the VS Code API.

### WebView Mode

1. On startup, discovers which LLM extensions are installed by scanning registered VS Code commands.
2. Periodically calls the discovered approval commands via `vscode.commands.executeCommand`.
3. Each command only fires when its specific extension's webview tab is visible (tab label matching).
4. User-configured commands are validated against an allowlist of known extension prefixes.

**No OS-level keystroke simulation, no shell execution, no command injection risk.**

## Setup

### Install from Marketplace

Search for **"LLM Auto Confirm"** in the VS Code Extensions view, or install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/).

The extension is enabled by default (terminal mode). Just install and use your LLM tool as usual.

### Install from Source

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to run in development mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.4.0.vsix
```

## Usage

1. Install the extension
2. Open a terminal in VS Code
3. Run your LLM tool (e.g., `claude`, `aider`)
4. Permission prompts are automatically confirmed

Use the status bar item or Command Palette to toggle auto-confirm on/off.

## Requirements

- **VS Code 1.93+** (for Terminal Shell Integration API)
- Shell integration must be enabled (it is by default)

## Configuration

### Terminal Settings

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `true` | Enable auto-confirmation on startup |
| `llmAutoConfirm.commandPatterns` | `["claude", "aider", "goose", "codex"]` | Command patterns to monitor in terminals |
| `llmAutoConfirm.confirmResponse` | `"1"` | Fallback text to send when no prompt rule matches |
| `llmAutoConfirm.cooldown` | `1000` | Cooldown (ms) after confirming before checking again |
| `llmAutoConfirm.promptPatterns` | *(see below)* | Fallback regex patterns for permission prompts |
| `llmAutoConfirm.promptRules` | *(see below)* | Rules with per-pattern responses (checked first) |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Patterns for commands to never auto-approve |
| `llmAutoConfirm.periodicFallback` | `false` | When the output stream ends, periodically send confirmResponse without prompt detection. **Advanced, use with caution.** |
| `llmAutoConfirm.periodicFallbackMaxSends` | `10` | Max periodic fallback sends per terminal session (1–100) |
| `llmAutoConfirm.debug` | `false` | Enable verbose debug logging (raw terminal output, match details, tick logs) |

### WebView Settings

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.webviewAutoConfirm` | `false` | Enable command-based WebView auto-confirm (experimental) |
| `llmAutoConfirm.webviewPollInterval` | `3000` | How often (ms) to attempt the approval command |
| `llmAutoConfirm.webviewApprovalCommands` | `[]` | Additional VS Code command IDs to try (user entries checked first) |

Built-in commands for Kilo Code, Claude Code (diff only), Cline, and Roo Code are always included. User-configured commands are validated against an allowlist of known LLM extension prefixes. Add custom entries for other extensions:

```json
{
  "llmAutoConfirm.webviewApprovalCommands": [
    { "name": "My Extension", "command": "myext.approveAction" }
  ]
}
```

### Default Prompt Rules

```json
[
  {
    "name": "Claude Code (numbered prompt)",
    "pattern": "(?:Allow|approve|Do you want)[\\s\\S]*?\\d+\\s*\\.?\\s*Yes",
    "response": "1",
    "addNewline": false
  },
  {
    "name": "Claude Code (save file prompt)",
    "pattern": "Save file to continue[\\s\\S]*?\\d+\\s*\\.?\\s*Yes",
    "response": "1",
    "addNewline": false
  },
  {
    "name": "Codex (selection list)",
    "pattern": "Allow command\\?",
    "response": "",
    "addNewline": true
  },
  {
    "name": "Y/n prompt (Aider, etc.)",
    "pattern": "(?:Y\\/?n|y\\/N|\\(y\\)es|\\(n\\)o)",
    "response": "y",
    "addNewline": true
  }
]
```

### Default Fallback Patterns

Used with `confirmResponse` when no `promptRules` match:

```json
[
  "(?:Allow|Do you want).*(?:Yes|No)",
  "Save file to continue",
  "(?:Y\\/?n|y\\/N|\\(y\\)es|\\(n\\)o)"
]
```

You can add custom rules and patterns for other LLM tools.

## Safety

- **Dangerous command blocking**: Commands matching `dangerousCommandPatterns` are never auto-approved.
- **Status bar indicator**: Shows current state (Off / On / Watching) with mode label (Terminal / Terminal+WebView).
- **Output log**: All actions are logged to the "LLM Auto-Confirm" output channel.
- **Easy toggle**: Click the status bar item or use the Command Palette to stop at any time.
- **Terminal-scoped**: Only sends input to the specific terminal running the LLM tool. No keyboard/mouse interference.
- **WebView safety**: Uses VS Code command API only — no OS-level input simulation, no shell execution, no command injection risk. User-configured commands are validated against an allowlist of known LLM extension prefixes. Each built-in command is bound to its extension's webview tab label, preventing cross-extension misfires.
- **Periodic fallback off by default**: The fallback mode (blind send without prompt detection) is disabled by default and requires explicit opt-in.

## Comparison with Python Script

| Feature | Python Script | VS Code Extension |
|---|---|---|
| Technique | Screenshot + OpenCV | Terminal Shell Integration API |
| Mouse movement | Briefly moves and restores | None |
| Setup required | Just run | Just install (no special flags) |
| Works minimized | No | Yes |
| CPU usage | Higher (screen capture) | Minimal (event-driven) |
| Universality | Any app on screen | Terminal-based LLM tools in VS Code |
