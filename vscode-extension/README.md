# LLM Auto-Confirm (VS Code Extension)

A VS Code extension that auto-clicks confirmation/approval buttons for LLM coding assistants (Claude, Copilot, Cursor, etc.) using the Chrome DevTools Protocol. No mouse movement, no screen capture — works entirely in the background.

## How It Works

1. Your IDE is launched with `--remote-debugging-port=9222`.
2. The extension connects to the IDE's renderer process via CDP.
3. It polls the DOM for confirmation buttons matching configurable CSS selectors and text patterns.
4. When a match is found, it clicks the button programmatically.
5. Dangerous commands (e.g., `rm -rf /`) are automatically blocked.

## Setup

### Step 1: Launch IDE with Remote Debugging

**VS Code (Windows)**
```
code --remote-debugging-port=9222
```

**VS Code (macOS)**
```
code --remote-debugging-port=9222
```

**Cursor**
```
cursor --remote-debugging-port=9222
```

To make this persistent, add the flag to your IDE shortcut or shell alias.

### Step 2: Install Extension

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` in VS Code to run the extension in development mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.1.0.vsix
```

### Step 3: Start Auto-Confirm

- Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
- Run **"LLM Auto Confirm: Start"**
- Or click the status bar item to toggle

## Configuration

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `false` | Auto-start on VS Code launch |
| `llmAutoConfirm.pollingInterval` | `2000` | DOM polling interval (ms) |
| `llmAutoConfirm.debugPort` | `9222` | CDP remote debugging port |
| `llmAutoConfirm.buttonSelectors` | *(see below)* | CSS selectors for approval buttons |
| `llmAutoConfirm.buttonTextPatterns` | `["Allow", "Accept", ...]` | Button text patterns to match |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Commands to never auto-approve |

### Default Button Selectors

```json
[
  "button[title*='Allow']",
  "button[title*='Accept']",
  "button[title*='Proceed']",
  "button[title*='Yes']",
  "button[title*='Continue']",
  "button[title*='Run']",
  "div.cursor-button-primary",
  "a.monaco-button[title*='Allow']",
  "a.monaco-button[title*='Accept']",
  "a.monaco-button[title*='Yes']",
  "a.monaco-button[title*='Continue']"
]
```

You can add your own selectors for other LLM tools.

## Safety

- **Dangerous command blocking**: Commands matching `dangerousCommandPatterns` are never auto-approved.
- **Status bar indicator**: Shows current state (Off / On / Error) and click count.
- **Output log**: All actions are logged to the "LLM Auto-Confirm" output channel.
- **Easy toggle**: Click the status bar item or use the Command Palette to stop at any time.

## Comparison with Python Script

| Feature | Python Script | VS Code Extension |
|---|---|---|
| Technique | Screenshot + OpenCV | CDP DOM inspection |
| Mouse movement | Briefly moves and restores | None |
| Works minimized | No | Yes |
| CPU usage | Higher (screen capture) | Lower (DOM query) |
| Setup | Just run | Needs `--remote-debugging-port` |
| Universality | Any app on screen | IDE-only (VS Code, Cursor) |
