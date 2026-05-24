# LLM Auto-Confirm (VS Code Extension)

A VS Code extension that auto-confirms permission prompts for LLM coding assistants (Claude Code, Aider, Goose, Codex, etc.). Install and forget -- no special setup required.

Two cooperating mechanisms run depending on which tool is in use:

| Tool | Primary mechanism | Why |
|---|---|---|
| **Claude Code** (`claude`) | **PreToolUse hook** (auto-installed at `~/.claude/`) | Hook runs *inside* Claude Code before any TUI prompt is drawn -- 100% reliable, immune to terminal-stream silence that previously caused Read/WebSearch prompts to be missed. **The hook is machine-global**: all `claude` sessions on this machine are affected while any VS Code window is Active, including sessions launched outside VS Code. See the scope caveat below. |
| **Codex** (`codex`) | **Terminal Shell Integration** (the old path) | Codex has not exhibited stall issues in testing; the terminal monitor remains the right fit. |
| Anything else (Aider, Goose, custom) | Terminal Shell Integration | Same as Codex; rules are user-editable. |

The terminal monitor still runs for Claude Code as a **fallback**: if the hook ever fails to install (e.g., `node` not in `PATH`) or returns an error, the existing prompt-scraping logic still tries to confirm the prompt.

## Claude Code Hook Mode

### What gets installed

When the extension first activates **with auto-confirm enabled** (`llmAutoConfirm.enabled=true`, the default), it creates the following, idempotently and automatically -- no user action required beyond installing the extension itself:

```
~/.claude/
├─ settings.json                 # one entry appended under hooks.PreToolUse
└─ llm-auto-confirm/
   ├─ hook.js                    # the hook script (single file, ~120 LOC, zero deps)
   ├─ config-<window-A-id>.json  # per-window dangerous-command blacklist (one per window)
   ├─ config-<window-B-id>.json  # hook unions ALL config-*.json patterns across windows
   ├─ windows/
   │  ├─ <window-A-id>           # presence: this VS Code window is alive
   │  └─ <window-B-id>           # (refreshed every 60s regardless of toggle state)
   └─ sessions/
      └─ <window-A-id>           # vote: this window wants auto-approve right now
                                 # (only present while window is in Active mode)
```

**Presence vs vote** -- two independent signals, on purpose:
- `windows/<id>` is the presence heartbeat that says "this VS Code window is actively monitoring". It exists while monitoring is on, regardless of Active vs Observe Only.
- `sessions/<id>` is the vote that says "this window wants auto-approve right now". Only present in Active mode.
- The **hook** only reads `sessions/` (votes) -- pausing one window stops its vote without affecting other windows.
- The **Uninstall command** only reads `windows/` (presence) -- a paused window still keeps the global hook installed for itself, so it can resume to Active later without reinstalling.

**When `llmAutoConfirm.enabled=false`**: NONE of these files are created, **and the settings.json hook entry is not registered either**. A disabled window stays fully inert -- it doesn't mutate `~/.claude/` and doesn't count toward another window's Uninstall decision. If you later turn `llmAutoConfirm.enabled` back on (or run Start), the install runs lazily.

The settings.json entry looks like this and is identified by the command string `llm-auto-confirm`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "node \"~/.claude/llm-auto-confirm/hook.js\"" }
        ]
      }
    ]
  }
}
```

Existing settings (other hooks, permissions, model preferences, etc.) are **preserved** -- the extension reads, merges, and writes back without touching unrelated fields.

### How toggling works (per-window)

The status bar item toggles between **Active** and **Observe Only**, and `Start` / `Stop` still apply. **All of these are scoped to the current VS Code window** -- they affect only this window's session file:

| This window's state | This window's session file | Hook decision (across all windows) |
|---|---|---|
| Monitoring + Active | present, mtime fresh | This window votes "approve". Hook returns `allow` if any window votes approve. |
| Monitoring + Observe Only | absent | This window does not vote. Other windows still count. |
| Monitoring stopped | absent | Same as Observe Only. |
| Window closed (deactivate) | this window's file removed | Other windows' votes unaffected. |

The hook approves iff **at least one window**'s session file is present and mtime-fresh (within 10 minutes). This is a permissive union -- closing or pausing one window cannot disable Claude auto-approval running through another window.

**Important semantic**: "Observe Only" / "Stop" are now **per-window**, not global. If you have two VS Code windows open and pause auto-confirm in window A, window B's Claude session continues to auto-approve as long as B is still Active. To stop everywhere, pause/stop in every window.

**Scope caveat (machine-global hook with VS Code terminal heuristic)**: The hook is installed in `~/.claude/settings.json` and fires for every Claude Code session on this machine. To reduce the scope, the hook checks `TERM_PROGRAM`: VS Code sets `TERM_PROGRAM=vscode` in its integrated terminal environment, which Claude Code and this hook inherit. External terminals (iTerm, Windows Terminal, cmd, bare shell) set a different value or none and are deferred. **Known edge cases that still pass the guard**: an external terminal explicitly launched from VS Code (e.g., "Open in External Terminal") inherits `TERM_PROGRAM=vscode`; SSH/remote/devcontainer behavior depends on whether VS Code propagates the variable in that environment; WSL has the pre-existing HOME-mismatch limitation. This heuristic significantly narrows the scope but is not a strict session binding -- true session-level binding is future work.

Toggling is a single `fs.writeFile` / `fs.unlink` of this window's session file. There's no race, no JSON rewrite, no Claude Code restart needed -- the hook scans `sessions/` on every tool call.

### Differences from `--dangerously-skip-permissions` (YOLO)

| | `--dangerously-skip-permissions` | LLM Auto-Confirm hook |
|---|---|---|
| Decided at | Launch only | Per tool call |
| Toggleable mid-session | No (have to restart Claude) | Yes (status bar / `Start` / `Stop`) |
| Dangerous-command blacklist | None | Honored: hook returns `deny` for matches |
| Per-tool override | All-or-nothing | Configurable via `dangerousCommandPatterns` |

### Dangerous-command protection

When the hook receives a tool call, it tests the concatenation of `tool_name` + `JSON.stringify(tool_input)` against every regex in `llmAutoConfirm.dangerousCommandPatterns`. Any match -> `permissionDecision: "deny"` with a reason string Claude shows to itself, not auto-approval. Each VS Code window keeps its own `config-<window-id>.json` in `~/.claude/llm-auto-confirm/`; the hook reads and unions all of them. This means multiple workspaces each with different blacklists compose correctly -- no last-writer-wins overwriting.

### Uninstalling

Run **"LLM Auto Confirm: Uninstall Claude Code Hook"** from the Command Palette. The behavior depends on how many VS Code windows are using the hook:

- **No other VS Code windows alive**: full cleanup. Removes the entry from `~/.claude/settings.json` (other hooks/settings preserved) and deletes `~/.claude/llm-auto-confirm/`. Claude Code returns to showing prompts as before.
- **Any other VS Code windows still alive (Active OR paused)**: partial cleanup. Removes only this window's vote and presence files, but keeps `settings.json` and the hook directory intact so other windows keep working -- including any window that is currently paused but might later resume to Active. The notification tells you how many other live windows still hold the hook open. Run the same command in those windows (or close them) to fully remove.

To put it back, run **"LLM Auto Confirm: Reinstall Claude Code Hook"** or simply reload VS Code.

### What if I uninstall the extension from the VS Code Extensions panel?

VS Code does not give extensions a reliable "before uninstall" callback, so the hook script and settings.json entry are **not removed automatically** when you uninstall via the Extensions panel.

To prevent silent auto-approval after the extension is gone, each VS Code window writes two files that the running extension keeps fresh on a 60-second heartbeat:

- `windows/<id>` (presence) is refreshed while the window is monitoring (Active OR Observe Only). It tells the Uninstall command "this window is still alive". When monitoring is stopped, this file is removed.
- `sessions/<id>` (vote) is refreshed only while the window is in Active mode. The hook scans `sessions/` on every tool call and approves iff at least one vote file has **mtime within the last 10 minutes**.

Files older than 10 minutes are treated as inactive in both cases.

So after uninstalling the extension:
- The window stops refreshing both of its files. Within ~10 minutes its vote and presence age out.
- If you had only one window, the hook stops approving entirely; Claude returns to showing prompts.
- If you had other windows running the extension, they continue voting normally -- the hook keeps working for them.

For immediate cleanup, **run "Uninstall Claude Code Hook" before uninstalling the extension**. If no other windows are alive (Active OR paused), this removes the settings.json entry and the entire `~/.claude/llm-auto-confirm/` directory.

### Troubleshooting

- **Hook not firing**: confirm `node` is on Claude Code's `PATH`. The hook script is `node ~/.claude/llm-auto-confirm/hook.js` -- try running that command in the same shell Claude Code is launched from.
- **Toggle not affecting Claude**: check that `~/.claude/llm-auto-confirm/sessions/<your-window-id>` appears when you switch to Active and disappears when you switch to Observe Only / Stop. The window-id is `vscode.env.sessionId` for that VS Code window. Permissions on `~/.claude/llm-auto-confirm/` must allow VS Code to write.
- **Hook decision seems stale**: check `~/.claude/llm-auto-confirm/sessions/` and `~/.claude/llm-auto-confirm/windows/`. Files with `mtime` more than 10 minutes old are treated as inactive; if your Active window's vote file looks stale, the heartbeat may have failed (look in the "LLM Auto-Confirm" output channel).
- **Settings.json was not updated**: open the "LLM Auto-Confirm" output channel; failure messages from `ensureInstalled` are logged there. The most common cause is malformed JSON in your existing `settings.json`.
- **Want to verify hook output**: enable Claude Code's hook debug mode (see Anthropic's docs) -- it prints the hook's stdout/stderr.

## Compatibility

### Terminal Mode (default, enabled by default)

Reads terminal output via the VS Code Terminal Shell Integration API, matches prompts with regex, and sends the appropriate response to the specific terminal. Used as the primary path for Codex (and other terminal LLMs) and as a fallback for Claude Code.

The status bar toggle now switches between two runtime states without dropping terminal attachments:

- **Active**: prompt matches are auto-confirmed.
- **Observe Only**: prompt matches are logged, but no text is sent back to the terminal or WebView.

> **Testing status:** Only **Claude Code** and **Codex** have been tested at the code level against the actual CLI prompts. Rules for **Aider**, **Goose**, and the WebView entries below are written from each tool's documented prompt format but have **not** been verified end-to-end. Treat them as best-effort starting points -- if a rule misfires or fails to match, please open an issue.

| Tool | Terminal Command | Prompt Rule | Response | Status |
|------|-----------------|-------------|----------|--------|
| **Claude Code** | `claude` | `(?:Allow\|approve\|Do you want\|proceed\?)[\s\S]*?\d+\s*\.?\s*Yes` | `1` (auto-newline) | Verified (tested) |
| **Claude Code** | `claude` | `Save file to continue[\s\S]*?\d+\s*\.?\s*Yes` | `1` (auto-newline) | Verified (tested) |
| **Claude Code** | `claude` | `(?:❯\|›\|>)\s*\d+\s*\.?` (interactive list cursor) | Enter | Verified (tested) |
| **Codex CLI** | `codex` | `Allow command\?` | Enter | Verified (tested) |
| **Aider** | `aider` | `(?:[\[\(]\s*y\s*\/\s*n\s*[\]\)]\|\(y\)es\|\(n\)o)` | `y` + Enter | Untested |
| **Goose** | `goose` | Fallback patterns | `1` | Untested |
| **Any CLI tool** | User-configured | User-configured `promptRules` | User-configured | Extensible |

> The Y/n rule requires bracket or parenthesis wrapping (`[y/n]`, `(y/N)`, `(y)es/(n)o`) to avoid misfiring on prose that contains a bare `y/n`.

**Key:** Any LLM tool that runs in the terminal and prompts via text output can be supported by adding a `promptRule`.

### WebView Mode (experimental, opt-in, default off)

Calls known VS Code commands exposed by LLM extensions. This mode has significant limitations because most extensions handle permission prompts **inside their webview** and do not expose per-prompt approval commands.

> **Testing status:** None of the WebView integrations below have been tested at the code level -- the command IDs come from each extension's published manifest but the wiring has not been exercised end-to-end. If you rely on WebView mode, treat it as experimental and please report what works.

| Extension | VS Code Command | What It Does | Limitation |
|-----------|----------------|--------------|------------|
| **Kilo Code** | `kilo-code.toggleAutoApprove` | Enables auto-approve mode (one-shot) | Toggles a mode, not per-prompt; untested |
| **Kilo Code** | `kilo-code.acceptInput` | Accepts pending input | Untested |
| **Claude Code** | `claude-vscode.acceptProposedDiff` | Accepts editor diff proposals | Does **NOT** approve webview tool-use prompts; untested |
| **Cline** | `cline.approveTask` | Approves pending task | Untested (not installed) |
| **Roo Code** | `roo-cline.approveTask` | Approves pending task | Untested (not installed) |
| **Codex** | *(none)* | -- | No approval commands exposed |

**Recommendation per tool:**

| Tool | Best Approach |
|------|--------------|
| Claude Code | Use **terminal mode** (`claude` CLI) -- tested. WebView `acceptProposedDiff` only handles editor diffs. |
| Codex | Use **terminal mode** (`codex` CLI) -- tested. Or use Codex's own `--full-auto` flag. WebView has no commands. |
| Kilo Code | **WebView mode** wires `toggleAutoApprove` but is untested -- treat as experimental. |
| Cline / Roo Code | **WebView mode** may work (untested). |
| Aider / Goose | Use **terminal mode** (untested but rules are wired up). These are terminal-only tools. |

## How It Works

### Claude Code (PreToolUse hook)

1. On activation, the extension installs a `PreToolUse` hook into `~/.claude/settings.json` and drops `~/.claude/llm-auto-confirm/hook.js`.
2. Whenever Claude Code is about to invoke any tool, it spawns the hook script and pipes the tool call (name + arguments) to its stdin.
3. The hook scans `~/.claude/llm-auto-confirm/sessions/`:
   - **At least one session file with fresh mtime (≤10 min)** -> tests tool input against the dangerous-command blacklist; returns `permissionDecision: "allow"` if safe, `"deny"` if matched. Claude proceeds without ever drawing a permission prompt.
   - **Sessions dir empty / all files stale / dir missing** -> returns `{}` so Claude falls back to its default flow (showing the user a prompt).
4. Each VS Code window owns one session file (`sessions/<vscode.env.sessionId>`). The status bar toggle / `Start` / `Stop` commands create or remove THIS window's file and refresh its mtime every 60s while active. No restart of Claude Code is needed.

**Why this path exists**: VS Code's terminal shell-integration stream sometimes goes silent on short tool prompts (Read, WebSearch), so the older terminal-scraping path occasionally missed them. Hooks bypass the TUI entirely and are the documented Anthropic-supported integration point.

**Why per-window vote files**: A single global vote file would mean closing or pausing one VS Code window would silently disable Claude auto-approval for any other window. Per-window vote files (`sessions/<id>`) with permissive union semantics let each window manage its own state independently. A separate per-window presence file (`windows/<id>`) ensures the Uninstall command can tell "alive but paused" apart from "no longer here", so a paused window can still resume to Active without the global hook being uninstalled out from under it.

### Terminal Mode

1. The extension listens for terminal commands matching LLM tool patterns (e.g., `claude`, `codex`, `aider`).
2. When detected, it streams the terminal output using VS Code's Terminal Shell Integration API.
3. It matches the output against `promptRules` (checked in order; first match wins).
4. When a prompt matches, it sends the rule's configured response to that specific terminal in **Active** mode, or logs a suppressed match in **Observe Only** mode.
5. Dangerous commands (e.g., `rm -rf /`) are automatically blocked.

For Claude Code this is now a **fallback** behind the hook; for Codex and other terminal LLMs it is the primary path. **No CDP, no special flags, no mouse/keyboard interference** -- it only writes to the target terminal via the VS Code API.

### WebView Mode

1. On startup, discovers which LLM extensions are installed by scanning registered VS Code commands.
2. Periodically calls the discovered approval commands via `vscode.commands.executeCommand`.
3. Each command only fires when its specific extension's webview tab is visible (tab label matching).
4. User-configured commands are validated against an allowlist of known extension prefixes.

**No OS-level keystroke simulation, no shell execution, no command injection risk.**

## Setup

### Install from Marketplace

Search for **"LLM Auto Confirm"** in the VS Code Extensions view, or install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/).

The extension is enabled by default. Just install and use your LLM tool as usual.

On first activation **with `llmAutoConfirm.enabled=true`** (the default) it will:
- Install the Claude Code PreToolUse hook into `~/.claude/` (one-time info notification confirms the install).
- Start watching terminals for `claude`, `codex`, `aider`, and `goose` invocations.

If you set `llmAutoConfirm.enabled=false`, the extension stays inert -- it does not modify `~/.claude/settings.json` and does not register any Claude hook. Turning it back on (via the Start command, the status bar, or the config setting) installs the hook lazily on demand.

No additional commands or config changes are required.

### Install from Source

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to run in development mode, or package it:

```bash
npx vsce package
code --install-extension llm-auto-confirm-0.7.0.vsix
```

### Running tests

```bash
cd vscode-extension
npm test
```

Covers the multi-window vote/presence model in `claude-hook-installer.ts`, the P1 paused-window regression, P2 cleanup-vs-tick race defense, and end-to-end behavior of `resources/claude-hook.js` (sessions scan, dangerous-command blacklist, BOM-tolerant JSON parsing). Zero external test framework -- the runner uses the already-installed esbuild to bundle the installer for in-process loading and hook tests spawn `node` against the real script.

## Usage

1. Install the extension
2. Open a terminal in VS Code
3. Run your LLM tool (e.g., `claude`, `aider`)
4. Permission prompts are automatically confirmed

Use the status bar item to switch between **Active** and **Observe Only**. It does not stop monitoring. Use the Command Palette `Start` / `Stop` commands only when you want to fully start or stop monitoring.

## Requirements

- **VS Code 1.93+** (for Terminal Shell Integration API)
- Shell integration must be enabled (it is by default)

## Configuration

### Terminal Settings

| Setting | Default | Description |
|---|---|---|
| `llmAutoConfirm.enabled` | `true` | Start monitoring on startup (status bar still lets you pause auto-confirm into Observe Only mode) |
| `llmAutoConfirm.commandPatterns` | `["claude", "aider", "goose", "codex"]` | Command patterns to monitor in terminals |
| `llmAutoConfirm.confirmResponse` | `"1"` | Fallback text to send when no prompt rule matches |
| `llmAutoConfirm.cooldown` | `1000` | Cooldown (ms) after confirming before checking again |
| `llmAutoConfirm.promptPatterns` | *(see below)* | Fallback regex patterns for permission prompts |
| `llmAutoConfirm.promptRules` | *(see below)* | Rules with per-pattern responses (checked first) |
| `llmAutoConfirm.dangerousCommandPatterns` | `["rm -rf /", ...]` | Patterns for commands to never auto-approve |
| `llmAutoConfirm.debug` | `false` | Enable verbose debug logging (raw terminal output, match details) |

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
    "pattern": "(?:Allow|approve|Do you want|proceed\\?)[\\s\\S]*?\\d+\\s*\\.?\\s*Yes",
    "response": "1",
    "addNewline": "auto"
  },
  {
    "name": "Claude Code (save file prompt)",
    "pattern": "Save file to continue[\\s\\S]*?\\d+\\s*\\.?\\s*Yes",
    "response": "1",
    "addNewline": "auto"
  },
  {
    "name": "Claude Code (interactive list cursor)",
    "pattern": "(?:\\u276F|\\u203A|>)\\s*\\d+\\s*\\.?",
    "response": "",
    "addNewline": true
  },
  {
    "name": "Codex (selection list)",
    "pattern": "Allow command\\?",
    "response": "",
    "addNewline": true
  },
  {
    "name": "Y/n prompt (Aider, etc.)",
    "pattern": "(?:[\\[\\(]\\s*y\\s*\\/\\s*n\\s*[\\]\\)]|\\(y\\)es|\\(n\\)o)",
    "response": "y",
    "addNewline": true
  }
]
```

**`addNewline` values:**

| Value | Behavior |
|---|---|
| `true` | Append a newline after `response` (sends `response` + Enter). |
| `false` | Send `response` only -- no Enter. |
| `"auto"` | Auto-detect: if the buffer shows an interactive list cursor (`❯` / `›`) on the matched option, only Enter is sent (the cursor already points at the choice); otherwise behaves like `true` (`response` + Enter). |

### Default Fallback Patterns

Used with `confirmResponse` when no `promptRules` match:

```json
[
  "(?:Allow|Do you want).*(?:Yes|No)",
  "Save file to continue",
  "(?:[\\[\\(]\\s*y\\s*\\/\\s*n\\s*[\\]\\)]|\\(y\\)es|\\(n\\)o)"
]
```

You can add custom rules and patterns for other LLM tools.

## Safety

- **Dangerous command blocking**: Commands matching `dangerousCommandPatterns` are never auto-approved. The check runs in **both** the Claude Code hook (against the structured `tool_input` JSON) and the terminal monitor (against the rendered prompt text).
- **Toggle stops auto-approval (in this window) immediately**: Removing this window's session file takes effect on Claude Code's *next* tool call. Note: if another VS Code window still has auto-confirm Active, its session file alone is enough to keep the hook approving -- see "How toggling works (per-window)" above.
- **Status bar indicator**: Shows whether monitoring is stopped, active, or in observe-only mode, plus the current mode label (Terminal / Terminal+WebView).
- **Output log**: All actions are logged to the "LLM Auto-Confirm" output channel.
- **Observe-only toggle**: Click the status bar item to pause auto-confirm while keeping terminal watchers attached. For Claude Code, observe-only behaves like *not installed* -- Claude shows the prompt to you normally.
- **Terminal-scoped**: Only sends input to the specific terminal running the LLM tool. No keyboard/mouse interference.
- **WebView safety**: Uses VS Code command API only -- no OS-level input simulation, no shell execution, no command injection risk. User-configured commands are validated against an allowlist of known LLM extension prefixes. Each built-in command is bound to its extension's webview tab label, preventing cross-extension misfires.
- **Post-confirm cooldown**: After each terminal-monitor confirm, an 8-second cooldown prevents duplicate sends caused by TUI redraws.
- **Hook script is auditable**: It's a single ~120-line file with zero dependencies, located at `~/.claude/llm-auto-confirm/hook.js`. Read it before trusting it.
- **Stale-bounded blast radius**: A window's session file ages out within 10 minutes if the extension stops refreshing it (uninstall, disable, crash, VS Code closed). The hook never silently auto-approves indefinitely after every contributing extension is gone.

## Comparison with Python Script

| Feature | Python Script | VS Code Extension |
|---|---|---|
| Technique | Screenshot + OpenCV | Terminal Shell Integration API |
| Mouse movement | Briefly moves and restores | None |
| Setup required | Just run | Just install (no special flags) |
| Works minimized | No | Yes |
| CPU usage | Higher (screen capture) | Minimal (event-driven) |
| Universality | Any app on screen | Terminal-based LLM tools in VS Code |
