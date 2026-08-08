#!/usr/bin/env node
// LLM Auto-Confirm: Claude Code PreToolUse hook
// See: https://github.com/sudoghut/llm-auto-confirm

const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_DIR = path.join(os.homedir(), ".claude", "llm-auto-confirm");
const SESSIONS_DIR = path.join(BASE_DIR, "sessions");
const WINDOWS_DIR = path.join(BASE_DIR, "windows");
// A session/presence file is considered "live" if its mtime is within this
// window. Each VS Code window refreshes both files every 60s while monitoring.
// The hook approves iff at least one session file is live (union semantics).
// Config files are only loaded for windows with a live presence file so that
// crashed or stopped windows do not keep their patterns active indefinitely.
const SESSION_MAX_AGE_MS = 10 * 60 * 1000;

function emit(obj) {
  try {
    // Exit from the write callback so stdout is fully flushed before the
    // process terminates. process.exit() called synchronously after write()
    // can truncate buffered output when stdout is a pipe under backpressure.
    process.stdout.write(JSON.stringify(obj), () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    let incomplete = false;
    const finish = (notComplete) => {
      if (settled) return;
      settled = true;
      incomplete = !!notComplete;
      resolve({ data, incomplete });
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    // Only a clean EOF means we have the full payload.
    process.stdin.on("end", () => finish(false));
    // I/O error or upstream close before EOF -- treat same as timeout: payload
    // may be partial, so defer rather than approve without inspecting tool_input.
    process.stdin.on("error", () => finish(true));
    // Timeout: stdin never closed in time -- same safe fallback as error.
    setTimeout(() => finish(true), 2000);
  });
}

/**
 * Returns true iff there exists at least one session file in SESSIONS_DIR
 * whose mtime is within SESSION_MAX_AGE_MS. Any error along the way (sessions
 * dir missing, readdir failure, individual stat failure) is treated as
 * "no live session" -- we always err toward NOT auto-approving.
 */
function hasLiveSession() {
  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return false;
  }
  const now = Date.now();
  for (const name of entries) {
    let stat;
    try {
      stat = fs.statSync(path.join(SESSIONS_DIR, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs <= SESSION_MAX_AGE_MS) return true;
  }
  return false;
}

(async () => {
  let raw = "";
  let stdinIncomplete = false;
  try {
    const result = await readStdin();
    raw = result.data;
    stdinIncomplete = result.incomplete;
  } catch {
    /* ignore */
  }

  // Decision is purely a function of sessions/. No global sentinel involved --
  // any one window's state change cannot disable auto-approval for others.
  if (!hasLiveSession()) {
    emit({});
    return;
  }

  // Heuristic terminal-scope guard: VS Code sets TERM_PROGRAM=vscode in its
  // integrated terminal environment; this value propagates through the shell
  // to Claude Code and then to this hook. External terminals (iTerm, Windows
  // Terminal, cmd, etc.) set a different value or none, so they are deferred.
  // This is not a cryptographic guarantee -- an external terminal explicitly
  // opened from VS Code may inherit TERM_PROGRAM=vscode and still pass this
  // guard; SSH/remote/devcontainer behavior depends on how VS Code propagates
  // the variable in those environments. See README for known limitations.
  if (process.env.TERM_PROGRAM !== "vscode") {
    emit({});
    return;
  }

  // Incomplete payload (timeout or stdin error): cannot safely inspect
  // tool_input against the blacklist. Defer rather than approve blindly.
  if (stdinIncomplete) {
    emit({});
    return;
  }

  // Strip leading UTF-8 BOM (U+FEFF) and surrounding whitespace some shells
  // add when piping. Use the \uFEFF escape rather than a literal BOM so the
  // intent survives editor / formatter / encoding round-trips.
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  let input = {};
  try {
    input = JSON.parse(cleaned || "{}");
  } catch {
    // Malformed input -- safest to defer rather than auto-approve.
    emit({});
    return;
  }
  // Non-object payloads (null, 42, "string", [...]) can't have tool_name /
  // tool_input and would throw on property access below -- defer safely.
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    emit({});
    return;
  }

  // Union dangerous patterns from per-window config files, but ONLY for
  // windows that have a live presence file in windows/ (mtime-fresh). This
  // prevents orphaned config files left by crashes, force-kills, or Stop
  // from keeping their patterns active indefinitely in other live sessions.
  // Config files for stopped windows were already removed by setMonitoringActive;
  // the liveness check here is the safety net for unclean exits.
  const patternSet = new Set();
  try {
    const now = Date.now();
    // Build the set of window IDs whose presence file is still fresh.
    const liveWindowIds = new Set();
    try {
      const windowEntries = fs.readdirSync(WINDOWS_DIR);
      for (const wname of windowEntries) {
        let wstat;
        try {
          wstat = fs.statSync(path.join(WINDOWS_DIR, wname));
        } catch { continue; }
        if (wstat.isFile() && now - wstat.mtimeMs <= SESSION_MAX_AGE_MS) {
          liveWindowIds.add(wname);
        }
      }
    } catch { /* windows/ dir missing -- no live windows, no configs to load */ }

    const entries = fs.readdirSync(BASE_DIR);
    for (const name of entries) {
      if (!name.startsWith("config-") || !name.endsWith(".json")) continue;
      // Only load config if the corresponding window is still live.
      const windowId = name.slice("config-".length, -".json".length);
      if (!liveWindowIds.has(windowId)) continue;
      try {
        const raw = fs.readFileSync(path.join(BASE_DIR, name), "utf8")
          .replace(/^\uFEFF/, "").trim();
        const cfg = JSON.parse(raw);
        if (Array.isArray(cfg.dangerousCommandPatterns)) {
          for (const p of cfg.dangerousCommandPatterns) patternSet.add(p);
        }
      } catch {
        /* malformed or missing individual config -- skip */
      }
    }
  } catch {
    /* BASE_DIR missing -- no blacklist */
  }
  const dangerousPatterns = [...patternSet];

  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = input.tool_input || {};
  let toolInputStr = "";
  try {
    toolInputStr = JSON.stringify(toolInput);
  } catch {
    toolInputStr = "";
  }
  const haystack = `${toolName} ${toolInputStr}`;

  for (const pat of dangerousPatterns) {
    let re;
    try {
      re = new RegExp(pat, "i");
    } catch {
      continue;
    }
    if (re.test(haystack)) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `LLM Auto-Confirm blocked: tool input matched dangerous pattern "${pat}".`,
        },
      });
      return;
    }
  }

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "LLM Auto-Confirm: auto-approved.",
    },
  });
})();
