// claude-hook.js end-to-end tests:
// - sessions/ scan logic (presence/freshness)
// - dangerous-command blacklist
// - BOM-tolerant JSON parsing for stdin and per-window config files
// - stdin incomplete paths: timeout (2s safety net) and non-object/null JSON payloads
//
// stdin 'error' path note: process.stdin emits 'error' on real I/O failures that
// are not reliably injectable from outside a subprocess (closing the parent write-end
// delivers EOF to the child, not an error event). The error handler calls finish(true)
// (same incomplete=true path as timeout), which is verified by code inspection and
// confirmed by the timeout test (H11) exercising the shared emit({}) branch.
//
// Each test spawns `node resources/claude-hook.js` with a controlled HOME and
// JSON piped to stdin. Verifies the JSON written to stdout.

const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

// envOverrides is merged last so each test can precisely control TERM_PROGRAM.
// TERM_PROGRAM is stripped from the base env for determinism: tests running
// inside a VS Code terminal would otherwise inherit TERM_PROGRAM=vscode and
// accidentally pass the terminal-scope guard even when not intended.
function runHook(ctx, stdinPayload, envOverrides = {}) {
  const base = { ...process.env, USERPROFILE: ctx.TEST_HOME, HOME: ctx.TEST_HOME };
  delete base.TERM_PROGRAM;
  const r = spawnSync(process.execPath, [ctx.HOOK_SCRIPT], {
    input: stdinPayload,
    encoding: "utf8",
    env: { ...base, ...envOverrides },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

function parseDecision(stdout) {
  if (!stdout || !stdout.trim()) return { kind: "empty" };
  const obj = JSON.parse(stdout);
  if (!obj.hookSpecificOutput) return { kind: "defer", obj };
  return {
    kind: obj.hookSpecificOutput.permissionDecision || "unknown",
    obj,
  };
}

function ageOut(filePath, minutes = 11) {
  const past = new Date(Date.now() - minutes * 60 * 1000);
  fs.utimesSync(filePath, past, past);
}

// Spawn the hook with stdin held open (write nothing, never call .end()).
// The hook's 2s internal timeout fires and emits {} (defer). Returns a Promise
// so the test runner can await it. Uses async spawn, not spawnSync, because
// spawnSync always closes the write-end after writing (even 0 bytes), which
// would deliver an immediate EOF to the child instead of a genuine timeout.
function runHookKeepStdinOpen(ctx, envOverrides = {}) {
  const base = { ...process.env, USERPROFILE: ctx.TEST_HOME, HOME: ctx.TEST_HOME };
  delete base.TERM_PROGRAM;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ctx.HOOK_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...base, ...envOverrides },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    // Kill the child if it somehow hasn't exited within 8s (safety ceiling).
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.on("close", () => {
      clearTimeout(killTimer);
      resolve(parseDecision(stdout));
    });
    // Intentionally do NOT write to or close child.stdin: the hook's 2s safety
    // timer is the only thing that will settle readStdin().
  });
}

module.exports = {
  name: "hook script (sessions scan + blacklist + BOM tolerance)",
  tests: [
    {
      name: "H1 sessions/ does not exist => DEFER",
      fn: async (ctx) => {
        const r = runHook(ctx, '{"tool_name":"Read","tool_input":{}}');
        const d = parseDecision(r.stdout);
        ctx.assert(
          "stdout is empty object",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
    {
      name: "H2 sessions/ exists but empty => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        const r = runHook(ctx, '{"tool_name":"Read","tool_input":{}}');
        const d = parseDecision(r.stdout);
        ctx.assert("defer", d.kind === "defer" || d.kind === "empty", r.stdout);
      },
    },
    {
      name: "H3 one fresh session => ALLOW",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const r = runHook(ctx, '{"tool_name":"Read","tool_input":{"file_path":"foo"}}', { TERM_PROGRAM: "vscode" });
        const d = parseDecision(r.stdout);
        ctx.assert("allow", d.kind === "allow", r.stdout);
      },
    },
    {
      name: "H4 stale session (mtime 11 min ago) => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), "x");
        ageOut(ctx.paths.sessionFile("win-A"));
        const r = runHook(ctx, '{"tool_name":"Read","tool_input":{}}');
        const d = parseDecision(r.stdout);
        ctx.assert("defer (stale)", d.kind === "defer" || d.kind === "empty", r.stdout);
      },
    },
    {
      name: "H5 A stale + B fresh => ALLOW (vote union)",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), "x");
        ageOut(ctx.paths.sessionFile("win-A"));
        fs.writeFileSync(ctx.paths.sessionFile("win-B"), String(Date.now()));
        const r = runHook(ctx, '{"tool_name":"Read","tool_input":{}}', { TERM_PROGRAM: "vscode" });
        const d = parseDecision(r.stdout);
        ctx.assert("allow via B", d.kind === "allow", r.stdout);
      },
    },
    {
      name: "H6 dangerous command in tool_input => DENY",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        fs.mkdirSync(path.dirname(ctx.paths.windowConfigFile("win-A")), { recursive: true });
        fs.writeFileSync(
          ctx.paths.windowConfigFile("win-A"),
          JSON.stringify({ dangerousCommandPatterns: ["rm -rf /"] })
        );
        // Presence file required: hook only loads config for live windows.
        fs.mkdirSync(ctx.paths.windowsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.windowFile("win-A"), String(Date.now()));
        const r = runHook(
          ctx,
          '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}',
          { TERM_PROGRAM: "vscode" }
        );
        const d = parseDecision(r.stdout);
        ctx.assert("deny", d.kind === "deny", r.stdout);
        ctx.assert(
          "deny includes pattern in reason",
          d.obj?.hookSpecificOutput?.permissionDecisionReason?.includes("rm -rf /") === true
        );
      },
    },
    {
      name: "H7 dangerous pattern but safe input => ALLOW",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        fs.mkdirSync(path.dirname(ctx.paths.windowConfigFile("win-A")), { recursive: true });
        fs.writeFileSync(
          ctx.paths.windowConfigFile("win-A"),
          JSON.stringify({ dangerousCommandPatterns: ["rm -rf /"] })
        );
        // Presence file: makes config live so the pattern is actually tested.
        fs.mkdirSync(ctx.paths.windowsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.windowFile("win-A"), String(Date.now()));
        const r = runHook(
          ctx,
          '{"tool_name":"Read","tool_input":{"file_path":"foo"}}',
          { TERM_PROGRAM: "vscode" }
        );
        const d = parseDecision(r.stdout);
        ctx.assert("allow (no match)", d.kind === "allow", r.stdout);
      },
    },
    {
      name: "H8 BOM-prefixed stdin still parsed => ALLOW",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        // U+FEFF BOM + JSON
        const bom = "﻿";
        const r = runHook(
          ctx,
          bom + '{"tool_name":"Read","tool_input":{"file_path":"foo"}}',
          { TERM_PROGRAM: "vscode" }
        );
        const d = parseDecision(r.stdout);
        ctx.assert("allow despite BOM in stdin", d.kind === "allow", r.stdout);
      },
    },
    {
      name: "H9 BOM-prefixed config file still respected => DENY on match",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const bom = "﻿";
        fs.mkdirSync(path.dirname(ctx.paths.windowConfigFile("win-A")), { recursive: true });
        fs.writeFileSync(
          ctx.paths.windowConfigFile("win-A"),
          bom + JSON.stringify({ dangerousCommandPatterns: ["mkfs\\."] })
        );
        // Presence file required for config to be loaded by liveness check.
        fs.mkdirSync(ctx.paths.windowsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.windowFile("win-A"), String(Date.now()));
        const r = runHook(
          ctx,
          '{"tool_name":"Bash","tool_input":{"command":"mkfs.ext4 /dev/sda1"}}',
          { TERM_PROGRAM: "vscode" }
        );
        const d = parseDecision(r.stdout);
        ctx.assert(
          "deny despite BOM in per-window config file",
          d.kind === "deny",
          r.stdout
        );
      },
    },
    {
      name: "H10 malformed stdin (with fresh session) => DEFER (safe default)",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const r = runHook(ctx, "not-json{{", { TERM_PROGRAM: "vscode" });
        const d = parseDecision(r.stdout);
        ctx.assert(
          "defer on parse failure",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
    {
      // Covers the stdin timeout path (incomplete=true): hook never receives EOF
      // within 2s, so it defers instead of approving without inspecting tool_input.
      // This test intentionally takes ~2s; it is the canonical regression guard for
      // the "timeout => allow" bug (P1 fix).
      name: "H11 stdin timeout -- hook never gets EOF within 2s => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const d = await runHookKeepStdinOpen(ctx, { TERM_PROGRAM: "vscode" });
        ctx.assert(
          "defer on stdin timeout",
          d.kind === "defer" || d.kind === "empty",
          d.raw || ""
        );
      },
    },
    {
      name: "H12 non-object JSON: null payload => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const r = runHook(ctx, "null", { TERM_PROGRAM: "vscode" });
        const d = parseDecision(r.stdout);
        ctx.assert(
          "defer on null payload",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
    {
      name: "H13 non-object JSON: array payload => DEFER (blacklist bypass guard)",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        fs.writeFileSync(
          ctx.paths.configPath,
          JSON.stringify({ dangerousCommandPatterns: ["rm -rf /"] })
        );
        // Attacker-style payload: top-level array that would have thrown on
        // property access before the non-object guard was added.
        const r = runHook(ctx, '["Bash","rm -rf /"]', { TERM_PROGRAM: "vscode" });
        const d = parseDecision(r.stdout);
        ctx.assert(
          "defer on array payload (not allow, not deny)",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
    {
      name: "H14 non-object JSON: number payload => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const r = runHook(ctx, "42", { TERM_PROGRAM: "vscode" });
        const d = parseDecision(r.stdout);
        ctx.assert(
          "defer on numeric payload",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
    {
      // Union semantics: two windows with different blacklists -> both patterns denied.
      name: "H_UNION two per-window configs => patterns from both are denied",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const cfgDir = path.join(ctx.paths.hookDir);
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.writeFileSync(
          ctx.paths.windowConfigFile("win-A"),
          JSON.stringify({ dangerousCommandPatterns: ["rm -rf /"] })
        );
        fs.writeFileSync(
          ctx.paths.windowConfigFile("win-B"),
          JSON.stringify({ dangerousCommandPatterns: ["mkfs\\."] })
        );
        // Presence files for both windows: hook only loads configs for live windows.
        fs.mkdirSync(ctx.paths.windowsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.windowFile("win-A"), String(Date.now()));
        fs.writeFileSync(ctx.paths.windowFile("win-B"), String(Date.now()));
        // Pattern from win-A config -> DENY
        const r1 = runHook(
          ctx,
          '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}',
          { TERM_PROGRAM: "vscode" }
        );
        ctx.assert("A pattern denied", parseDecision(r1.stdout).kind === "deny", r1.stdout);
        // Pattern from win-B config -> DENY
        const r2 = runHook(
          ctx,
          '{"tool_name":"Bash","tool_input":{"command":"mkfs.ext4 /dev/sda"}}',
          { TERM_PROGRAM: "vscode" }
        );
        ctx.assert("B pattern denied", parseDecision(r2.stdout).kind === "deny", r2.stdout);
      },
    },
    {
      // Orphaned config (no presence file) must not affect active sessions.
      // Simulates a crashed or force-killed VS Code window whose config-*.json
      // was not cleaned up. The hook must ignore it and ALLOW the command.
      name: "H_STALE orphaned config without live presence => patterns ignored => ALLOW",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        // Write config WITHOUT corresponding windows/ presence file.
        fs.mkdirSync(ctx.paths.hookDir, { recursive: true });
        fs.writeFileSync(
          ctx.paths.windowConfigFile("win-A"),
          JSON.stringify({ dangerousCommandPatterns: ["rm -rf /"] })
        );
        // No ctx.paths.windowFile("win-A") written -- simulates crash/Stop.
        const r = runHook(
          ctx,
          '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}',
          { TERM_PROGRAM: "vscode" }
        );
        const d = parseDecision(r.stdout);
        ctx.assert(
          "orphaned config ignored => ALLOW (not deny)",
          d.kind === "allow",
          r.stdout
        );
      },
    },
    {
      // Terminal-scope guard: a fresh session exists but TERM_PROGRAM is not
      // "vscode" (external terminal). Hook must defer rather than approve.
      name: "H_GUARD external TERM_PROGRAM (fresh session) => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        const r = runHook(
          ctx,
          '{"tool_name":"Read","tool_input":{}}',
          { TERM_PROGRAM: "iTerm.app" }
        );
        const d = parseDecision(r.stdout);
        ctx.assert(
          "external terminal deferred despite live session",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
    {
      // No TERM_PROGRAM at all (bare shell / CI / Windows cmd): must also defer.
      name: "H_GUARD2 absent TERM_PROGRAM (fresh session) => DEFER",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.writeFileSync(ctx.paths.sessionFile("win-A"), String(Date.now()));
        // runHook strips TERM_PROGRAM from the base env; no envOverrides here.
        const r = runHook(ctx, '{"tool_name":"Read","tool_input":{}}');
        const d = parseDecision(r.stdout);
        ctx.assert(
          "absent TERM_PROGRAM deferred despite live session",
          d.kind === "defer" || d.kind === "empty",
          r.stdout
        );
      },
    },
  ],
};
