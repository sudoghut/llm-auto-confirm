# LLM Auto-Confirm

Automatically confirms permission prompts for LLM coding assistants (Claude Code, Aider, Goose, Codex, etc.). Stay hands-free while your AI assistant works.

Two approaches included:

| | Python Script | VS Code Extension |
|---|---|---|
| **Technique** | Screenshot + OpenCV template matching | Terminal Shell Integration API + VS Code Command API |
| **Mouse movement** | Briefly moves & restores | None |
| **Works minimized** | No | Yes |
| **CPU usage** | Higher (screen capture) | Minimal (event-driven) |
| **Setup** | Just run | Just install (no special flags) |
| **Scope** | Any app on screen | Terminal + WebView LLM tools in VS Code |

---

## Option 1: Python Script (Universal)

Works with any application — captures a screenshot template of a button, then continuously monitors the screen and clicks it when found.

### Requirements

- **OS:** Windows or macOS
- **Python:** 3.8+
- Dependencies are auto-installed on first run: `pyautogui`, `opencv-python`, `Pillow`, `numpy`

| Platform | Notes |
|---|---|
| **Windows** | DPI awareness is handled automatically. |
| **macOS** | Retina display coordinates are handled automatically. You may need to grant **Screen Recording** and **Accessibility** permissions in System Settings > Privacy & Security. |

### Quick Start

```bash
# 1. Capture a button template (a GUI will open for region selection)
python auto_confirm.py --capture

# 2. Start monitoring and auto-clicking
python auto_confirm.py
```

Press `Ctrl+C` to stop. Move mouse to the top-left corner for emergency stop (PyAutoGUI failsafe).

### Usage

```
python auto_confirm.py [options]
```

| Option | Default | Description |
|---|---|---|
| `--capture [NAME]`, `-c` | — | Capture a button template (default name: `confirm`). |
| `--confidence FLOAT` | `0.85` | Match confidence threshold (0.0–1.0). Lower = more lenient. |
| `--interval FLOAT` | `0.5` | Screen check interval in seconds. |
| `--cooldown FLOAT` | `2.0` | Cooldown after each click in seconds. |
| `--list`, `-l` | — | List all saved templates. |

### Examples

```bash
python auto_confirm.py --capture allow           # Capture a template named "allow"
python auto_confirm.py --confidence 0.8           # Lower threshold
python auto_confirm.py --interval 0.3 --cooldown 1.0  # Faster checking
python auto_confirm.py --list                     # List saved templates
```

### Templates

Stored as `.png` files in `templates/`. Capture multiple for different tools:

```bash
python auto_confirm.py --capture claude_allow
python auto_confirm.py --capture copilot_accept
python auto_confirm.py --capture cursor_yes
```

### Safety

- **Failsafe:** Move mouse to top-left corner to trigger PyAutoGUI's emergency stop.
- **Cooldown:** Prevents rapid repeated clicks.
- **Confidence threshold:** Only clicks when confidence exceeds the threshold.
- **Duplicate detection:** Only one instance can run at a time (PID file lock).
- **Desktop notification:** Notifies you when monitoring stops.

---

## Option 2: VS Code Extension (Terminal + WebView)

Monitors terminal output using VS Code's Terminal Shell Integration API. Auto-detects when you run an LLM tool (e.g., `claude`, `aider`) and confirms permission prompts automatically. Optionally supports WebView-based LLM extensions via the VS Code command API.

### Setup

**Install from Marketplace:**

Search for **"LLM Auto Confirm"** in the VS Code Extensions view.

The extension is enabled by default (terminal mode). Just install and use your LLM tool as usual.

**Or build from source:**

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to run in dev mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.4.0.vsix
```

### Requirements

- **VS Code 1.93+**
- Shell integration enabled (on by default)

### Supported Tools

| Tool | Mode | Status |
|------|------|--------|
| **Claude Code** (`claude` CLI) | Terminal | Verified |
| **Codex** (`codex` CLI) | Terminal | Should work |
| **Aider** | Terminal | Should work |
| **Goose** | Terminal | Should work |
| **Kilo Code** | WebView | Verified (via `toggleAutoApprove`) |
| **Cline / Roo Code** | WebView | Unverified |
| **Codex** (WebView panel) | — | Not supported (no approval commands) |

### Configuration

#### Terminal Settings

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `true` | Enable auto-confirmation on startup |
| `llmAutoConfirm.commandPatterns` | `["claude", "aider", "goose", "codex"]` | Command patterns to monitor |
| `llmAutoConfirm.confirmResponse` | `"1"` | Fallback text to send when no prompt rule matches |
| `llmAutoConfirm.cooldown` | `1000` | Cooldown (ms) after confirming |
| `llmAutoConfirm.promptRules` | *(built-in)* | Rules with per-pattern responses (checked first) |
| `llmAutoConfirm.promptPatterns` | *(built-in)* | Fallback regex patterns for permission prompts |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Commands to never auto-approve |
| `llmAutoConfirm.periodicFallback` | `false` | Periodically send confirmResponse when output stream ends (advanced) |
| `llmAutoConfirm.periodicFallbackMaxSends` | `10` | Max periodic sends per session |

#### WebView Settings

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.webviewAutoConfirm` | `false` | Enable command-based WebView auto-confirm (experimental) |
| `llmAutoConfirm.webviewPollInterval` | `3000` | How often (ms) to attempt the approval command |
| `llmAutoConfirm.webviewApprovalCommands` | `[]` | Additional VS Code command IDs to try |

#### Other

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.debug` | `false` | Enable verbose debug logging in the output channel |

### Safety

- **Dangerous command blocking:** Commands matching danger patterns are never auto-approved.
- **Status bar indicator:** Shows state (Off / On / Watching) with mode label.
- **Output log:** All actions logged to the "LLM Auto-Confirm" output channel.
- **Terminal-scoped:** Only sends input to the specific terminal running the LLM tool.
- **WebView safety:** Command allowlist prevents workspace config injection; per-extension tab label matching prevents cross-extension misfires.
- **Periodic fallback off by default:** Blind send mode requires explicit opt-in.

See [vscode-extension/README.md](vscode-extension/README.md) for full details.

---

## License

MIT
