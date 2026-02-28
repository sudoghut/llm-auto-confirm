# LLM Auto-Confirm (VS Code Extension)

A VS Code extension that auto-confirms permission prompts for LLM coding assistants (Claude Code, Aider, Goose, Codex, etc.) running in the terminal. Install and forget — no special setup required.

## How It Works

1. The extension listens for terminal commands matching LLM tool patterns (e.g., `claude`, `aider`).
2. When detected, it streams the terminal output using VS Code's Terminal Shell Integration API.
3. It monitors the output for permission prompt patterns (e.g., "Allow ... Yes/No").
4. When a prompt is found, it sends a confirmation response (`y`) to that specific terminal.
5. Dangerous commands (e.g., `rm -rf /`) are automatically blocked.

**No CDP, no special flags, no mouse/keyboard interference** — it only writes to the target terminal via the VS Code API.

## Setup

### Install from Marketplace

Search for **"LLM Auto Confirm"** in the VS Code Extensions view, or install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/).

The extension is enabled by default. Just install and use your LLM tool as usual.

### Install from Source

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to run in development mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.2.0.vsix
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

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `true` | Enable auto-confirmation on startup |
| `llmAutoConfirm.commandPatterns` | `["claude", "aider", "goose", "codex"]` | Command patterns to monitor |
| `llmAutoConfirm.confirmResponse` | `"y"` | Text to send to confirm prompts |
| `llmAutoConfirm.cooldown` | `1000` | Cooldown (ms) after confirming |
| `llmAutoConfirm.promptPatterns` | *(see below)* | Regex patterns for permission prompts |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Commands to never auto-approve |

### Default Prompt Patterns

```json
[
  "Allow.*(?:Yes|No)",
  "Do you want to (?:proceed|continue|allow|run).*\\?",
  "(?:Y\\/?n|y\\/N|\\(y\\)es|\\(n\\)o)"
]
```

You can add custom patterns for other LLM tools.

## Safety

- **Dangerous command blocking**: Commands matching `dangerousCommandPatterns` are never auto-approved.
- **Status bar indicator**: Shows current state (Off / On / Watching) and confirm count.
- **Output log**: All actions are logged to the "LLM Auto-Confirm" output channel.
- **Easy toggle**: Click the status bar item or use the Command Palette to stop at any time.
- **Terminal-scoped**: Only sends input to the specific terminal running the LLM tool. No keyboard/mouse interference.

## Comparison with Python Script

| Feature | Python Script | VS Code Extension |
|---|---|---|
| Technique | Screenshot + OpenCV | Terminal Shell Integration API |
| Mouse movement | Briefly moves and restores | None |
| Setup required | Just run | Just install (no special flags) |
| Works minimized | No | Yes |
| CPU usage | Higher (screen capture) | Minimal (event-driven) |
| Universality | Any app on screen | Terminal-based LLM tools in VS Code |
