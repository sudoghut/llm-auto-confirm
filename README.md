# LLM Auto-Confirm

Automatically confirms permission prompts for LLM coding assistants (Claude Code, Aider, Goose, Codex, etc.). Stay hands-free while your AI assistant works.

Two approaches included:

| | Python Script | VS Code Extension |
|---|---|---|
| **Technique** | Screenshot + OpenCV template matching | Claude Code PreToolUse hook (for `claude`) + Terminal Shell Integration API (for `codex`, etc.) + VS Code Command API |
| **Mouse movement** | Briefly moves & restores | None |
| **Works minimized** | No | Yes |
| **Works without terminal focus** | No | Yes (hook runs inside Claude Code itself) |
| **CPU usage** | Higher (screen capture) | Minimal (event-driven) |
| **Setup** | Just run | Just install -- extension auto-installs the Claude Code hook |
| **Scope** | Any app on screen | Claude Code: hook fires machine-globally but defers external terminals via `TERM_PROGRAM=vscode` heuristic (iTerm, Windows Terminal, cmd are deferred; VS Code integrated terminals are approved). Other tools: VS Code terminals and WebView panels only. |

---

## Option 1: Python Script (Universal)

Works with any application -- captures a screenshot template of a button, then continuously monitors the screen and clicks it when found.

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
| `--capture [NAME]`, `-c` | -- | Capture a button template (default name: `confirm`). |
| `--confidence FLOAT` | `0.85` | Match confidence threshold (0.0-1.0). Lower = more lenient. |
| `--interval FLOAT` | `0.5` | Screen check interval in seconds. |
| `--cooldown FLOAT` | `2.0` | Cooldown after each click in seconds. |
| `--list`, `-l` | -- | List all saved templates. |

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

## Option 2: VS Code Extension (Hook + Terminal + WebView)

The extension uses **the right mechanism per LLM**:

- **Claude Code (`claude`)**: an auto-installed `PreToolUse` hook in `~/.claude/settings.json`. The hook runs inside Claude Code itself before any permission prompt would be drawn -- 100% reliable, immune to terminal-stream silence and independent of which window is focused.
- **Codex (`codex`)** and other terminal LLMs (Aider, Goose, ...): the original Terminal Shell Integration monitor -- proven to work for codex in practice.
- **WebView-based extensions** (Kilo, Cline, Roo Code, ...): VS Code command API (experimental, off by default).

The terminal monitor remains a **fallback** for Claude Code in case the hook fails to install (e.g., `node` not on `PATH`).

The VS Code extension supports two runtime states from the status bar:

- **Active**: auto-confirm is allowed to respond to prompts. For Claude Code this means **this window**'s session file is present and refreshed, contributing one "approve" vote to the hook.
- **Observe Only**: prompts are not auto-approved by **this window**. For Claude Code, this window's session file is removed; the hook still approves if any other VS Code window is Active. Other LLMs: terminal monitor still watches but only logs.

The status bar toggle only switches between these two states. It does not fully stop monitoring; use the extension `Start` / `Stop` commands for that.

**Per-window scope (Claude Code only)**: Pause / Stop / window-close affect only this window's vote. The hook unions across all open VS Code windows -- it approves iff at least one window's session file is present and fresh (within 10 min). To stop everywhere, pause/stop in every window or run "Uninstall Claude Code Hook".

**Differs from `claude --dangerously-skip-permissions`** in that the hook is **toggleable mid-session** (no restart of Claude Code) and still honors `dangerousCommandPatterns` as a server-side blacklist.

### Setup

**Install from Marketplace:**

Search for **"LLM Auto Confirm"** in the VS Code Extensions view.

The extension is enabled by default. Just install and use your LLM tool as usual.

On first activation it auto-installs the Claude Code PreToolUse hook into `~/.claude/` (a one-time info notification confirms the install). To remove it later, run **"LLM Auto Confirm: Uninstall Claude Code Hook"** from the Command Palette. See [vscode-extension/README.md](vscode-extension/README.md) for details on what files are touched and how to verify.

**Or build from source:**

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to run in dev mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.7.0.vsix
```

**Run tests:**

```bash
cd vscode-extension
npm test
```

See [vscode-extension/README.md](vscode-extension/README.md#running-tests) for what's covered.

### Requirements

- **VS Code 1.93+**
- Shell integration enabled (on by default)

### Supported Tools

> **Testing status:** Only **Claude Code** and **Codex** have been tested at the code level against the actual CLI prompts. The built-in rules for other tools (Aider, Goose, Kilo Code, Cline, Roo Code, ...) are written from each tool's documented prompt format but have **not** been verified end-to-end. Treat them as best-effort starting points -- if a rule misfires or fails to match, please open an issue.

| Tool | Mode | Status |
|------|------|--------|
| **Claude Code** (`claude` CLI) | Terminal | Verified (tested) |
| **Codex** (`codex` CLI) | Terminal | Verified (tested) |
| **Aider** | Terminal | Untested |
| **Goose** | Terminal | Untested |
| **Kilo Code** | WebView | Untested (rule wired via `toggleAutoApprove`) |
| **Cline / Roo Code** | WebView | Untested |
| **Codex** (WebView panel) | -- | Not supported (no approval commands) |

### Configuration

#### Terminal Settings

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `true` | Start monitoring on startup |
| `llmAutoConfirm.commandPatterns` | `["claude", "aider", "goose", "codex"]` | Command patterns to monitor |
| `llmAutoConfirm.confirmResponse` | `"1"` | Fallback text to send when no prompt rule matches |
| `llmAutoConfirm.cooldown` | `1000` | Cooldown (ms) after confirming |
| `llmAutoConfirm.promptRules` | *(built-in)* | Rules with per-pattern responses (checked first) |
| `llmAutoConfirm.promptPatterns` | *(built-in)* | Fallback regex patterns for permission prompts |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Commands to never auto-approve |

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

- **Dangerous command blocking:** Commands matching danger patterns are never auto-approved. Enforced both in the Claude Code hook (against the structured `tool_input` JSON) and in the terminal monitor (against the rendered prompt text).
- **Toggle is immediate:** Removing this window's vote file (via Stop / Observe-Only) prevents the hook from counting this window's vote on Claude Code's *next* tool call. (Other VS Code windows still using auto-confirm continue to vote independently.)
- **Status bar indicator:** Shows whether monitoring is stopped, active, or in observe-only mode.
- **Output log:** All actions logged to the "LLM Auto-Confirm" output channel.
- **Observe-only toggle:** Clicking the status bar pauses auto-confirm without detaching existing terminal watches.
- **Terminal-scoped:** Only sends input to the specific terminal running the LLM tool.
- **Hook script is auditable:** The Claude Code hook is a single ~120-line file with zero dependencies, located at `~/.claude/llm-auto-confirm/hook.js`.
- **Stale-bounded blast radius:** Each VS Code window's session file expires within 10 minutes if the extension stops refreshing it (uninstall via Extensions panel, disable, crash, VS Code closed). The hook never silently auto-approves indefinitely after every contributing extension is gone. To clean up immediately, run "LLM Auto Confirm: Uninstall Claude Code Hook" before uninstalling the extension.
- **WebView safety:** Command allowlist prevents workspace config injection; per-extension tab label matching prevents cross-extension misfires.

See [vscode-extension/README.md](vscode-extension/README.md) for full details on the hook installation, presence/vote file model, and uninstall flow.

---

## License

MIT
