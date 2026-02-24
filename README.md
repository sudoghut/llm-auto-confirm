# LLM Auto-Confirm

Automatically clicks confirmation/approval buttons for LLM coding assistants (Claude, GitHub Copilot, Cursor, Cody, etc.). Stay hands-free while your AI assistant works.

Two approaches included:

| | Python Script | VS Code Extension |
|---|---|---|
| **Technique** | Screenshot + OpenCV template matching | Chrome DevTools Protocol (CDP) |
| **Mouse movement** | Briefly moves & restores | None |
| **Works minimized** | No | Yes |
| **CPU usage** | Higher (screen capture) | Lower (DOM query) |
| **Setup** | Just run | Needs `--remote-debugging-port` |
| **Scope** | Any app on screen | IDE only (VS Code, Cursor) |

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

## Option 2: VS Code Extension (CDP-based)

Connects to the IDE's renderer process via Chrome DevTools Protocol. Polls the DOM for confirmation buttons and clicks them programmatically — no mouse movement, works even when minimized.

### Setup

**1. Launch IDE with remote debugging:**

```bash
code --remote-debugging-port=9222     # VS Code
cursor --remote-debugging-port=9222   # Cursor
```

**2. Build and install:**

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to run in dev mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.1.0.vsix
```

**3. Start:**

- Command Palette → **"LLM Auto Confirm: Start"**
- Or click the status bar item to toggle

### Configuration

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `false` | Auto-start on launch |
| `llmAutoConfirm.pollingInterval` | `2000` | DOM polling interval (ms) |
| `llmAutoConfirm.debugPort` | `9222` | CDP remote debugging port |
| `llmAutoConfirm.buttonSelectors` | *(built-in)* | CSS selectors for approval buttons |
| `llmAutoConfirm.buttonTextPatterns` | `["Allow", "Accept", ...]` | Button text to match |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Commands to never auto-approve |

### Safety

- **Dangerous command blocking:** Commands matching danger patterns are never auto-approved.
- **Status bar indicator:** Shows state (Off / On / Error) and click count.
- **Output log:** All actions logged to the "LLM Auto-Confirm" output channel.

See [vscode-extension/README.md](vscode-extension/README.md) for full details.

---

## License

MIT
