# LLM Auto-Confirm

Automatically clicks confirmation/approval buttons for LLM coding assistants (Claude, GitHub Copilot, Cursor, Cody, etc.) in any IDE or application. Stay hands-free while your AI assistant works.

Uses OpenCV template matching to find buttons on screen and PyAutoGUI to click them.

## How It Works

1. You capture a screenshot template of the button you want to auto-click (e.g. "Yes, Allow", "Proceed", "Accept").
2. The script continuously screenshots your display, searches for the template, and clicks it when found.
3. A configurable confidence threshold prevents false positives.

## Requirements

- **OS:** Windows or macOS
- **Python:** 3.8+
- Dependencies are auto-installed on first run:
  - `pyautogui`
  - `opencv-python`
  - `Pillow`
  - `numpy`

### Platform Notes

| Platform | Notes |
|---|---|
| **Windows** | DPI awareness is handled automatically. |
| **macOS** | Retina display coordinates are handled automatically. You may need to grant **Screen Recording** and **Accessibility** permissions in System Settings > Privacy & Security. |

## Quick Start

```bash
# 1. Capture a button template (a GUI window will open for you to select the button region)
python auto_confirm.py --capture

# 2. Start monitoring and auto-clicking
python auto_confirm.py
```

Press `Ctrl+C` to stop. You can also move your mouse to the top-left corner of the screen for an emergency stop (PyAutoGUI failsafe).

## Usage

```
python auto_confirm.py [options]
```

| Option | Default | Description |
|---|---|---|
| `--capture [NAME]`, `-c` | — | Capture a button template. Optionally provide a name (default: `confirm`). |
| `--confidence FLOAT` | `0.85` | Template matching confidence threshold (0.0–1.0). Lower = more lenient. |
| `--interval FLOAT` | `0.5` | Screen check interval in seconds. |
| `--cooldown FLOAT` | `2.0` | Cooldown after each click in seconds to prevent double-clicks. |
| `--list`, `-l` | — | List all saved templates. |

## Examples

```bash
# Capture a template named "allow"
python auto_confirm.py --capture allow

# Run with lower confidence (matches more easily)
python auto_confirm.py --confidence 0.8

# Check more frequently with shorter cooldown
python auto_confirm.py --interval 0.3 --cooldown 1.0

# List saved templates
python auto_confirm.py --list
```

## Templates

Templates are stored as `.png` files in the `templates/` directory. You can capture multiple templates — the script loads all of them and matches against the best one each cycle.

This makes it easy to handle different buttons across different tools:

```bash
python auto_confirm.py --capture claude_allow    # Claude's "Allow" button
python auto_confirm.py --capture copilot_accept  # Copilot's "Accept" button
python auto_confirm.py --capture cursor_yes      # Cursor's "Yes" button
```

## Safety

- **Failsafe:** Quickly move your mouse to the top-left corner of the screen to trigger PyAutoGUI's emergency stop.
- **Cooldown:** After each click, the script waits before clicking again to avoid rapid repeated clicks.
- **Confidence threshold:** Only clicks when the match confidence exceeds the configured threshold.

## License

MIT
