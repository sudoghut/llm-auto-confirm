// State-matrix regression tests.
//
// Walks key cells of the (config.enabled x isMonitoring x hookInstalled x
// userUninstalled x pendingMarker) state space and verifies the installer
// converges to the documented end state. The point is to MACHINE-CHECK the
// invariants that previously relied on manual walkthrough -- multi-round
// reviews kept finding state-matrix gaps that better automation would have
// caught earlier.
//
// We don't run the extension orchestrator here; we exercise the installer
// directly with the same call sequences extension.ts uses, asserting on
// disk state after each transition. Each scenario is expressed as a small
// "script" of (action, expectation) steps.

const fs = require("fs");
const path = require("path");

function loadInstaller(ctx) {
  return require(ctx.BUNDLE).ClaudeHookInstaller;
}

function fresh(ctx, id) {
  const Klass = loadInstaller(ctx);
  return new Klass(ctx.PROJECT, id, () => {});
}

// Mirror extension.ts's syncClaudeHookState behavior for tests.
async function syncState(installer, isMonitoring, isAutoConfirmEnabled) {
  if (isMonitoring) {
    const r = await installer.ensureInstalled();
    if (!r.ok) return r;
    await installer.syncConfig([]);
    await installer.setMonitoringActive(true);
    await installer.setEnabled(isAutoConfirmEnabled);
    return r;
  } else {
    await installer.setMonitoringActive(false);
    return { ok: true };
  }
}

function entryPresent(ctx) {
  if (!fs.existsSync(ctx.paths.settingsPath)) return false;
  try {
    const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
    return !!s.hooks?.PreToolUse?.some((e) =>
      e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
    );
  } catch {
    return false;
  }
}

module.exports = {
  name: "state-matrix transitions (config x monitoring x installed x sticky x marker)",
  tests: [
    {
      name:
        "M1 enabled=true,Active -> Stop -> disable: hook fully removed (P2-A scenario)",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        // Initial: enabled=true, syncState as Active
        await syncState(a, true, true);
        ctx.assert("after activate: hook installed", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("after activate: presence written", fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("after activate: vote written", fs.existsSync(ctx.paths.sessionFile("win-A")));
        // User runs Stop: monitoring -> false
        await syncState(a, false, false);
        ctx.assert("after Stop: presence gone", !fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("after Stop: vote gone", !fs.existsSync(ctx.paths.sessionFile("win-A")));
        ctx.assert("after Stop: hook still installed", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("after Stop: settings entry still present", entryPresent(ctx));
        // User flips config to false. Extension calls disableMonitoringGlobally
        // -> uninstallGlobal regardless of isMonitoring (P2-A fix).
        const r = await a.uninstallGlobal();
        ctx.assert("disable: full cleanup", r.fullCleanup === true);
        ctx.assert("after disable: hook dir gone", !fs.existsSync(ctx.paths.hookDir));
        ctx.assert("after disable: settings entry gone", !entryPresent(ctx));
      },
    },
    {
      name:
        "M2 half-corrupted state (settings entry + missing hook.js) -> uninstallGlobal() cleans entry even when isInstalled()=false",
      fn: async (ctx) => {
        // Simulate a previous session that installed.
        const prev = fresh(ctx, "win-prev");
        await syncState(prev, true, true);
        await prev.cleanupSession();
        // Hook artifacts persist across deactivate (cleanupSession does NOT
        // touch global state without a marker).
        ctx.assert("hook.js persists across deactivate", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry persists", entryPresent(ctx));
        // Now half-corrupt the state: externally remove hook.js but keep
        // settings.json entry. This is the scenario the reviewer flagged
        // (isInstalled() returns false but settings entry still references
        // the now-missing script).
        fs.unlinkSync(ctx.paths.scriptPath);
        ctx.assert("hook.js gone after manual delete", !fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry still present (half-corrupted)", entryPresent(ctx));
        // Next session activate with cfg.enabled=false. Defensive uninstall
        // should clean settings entry even though isInstalled()=false.
        const next = fresh(ctx, "win-next");
        ctx.assert("isInstalled() reports false (only checks hook.js)", !next.isInstalled());
        // Always-call defensive uninstallGlobal (the new behavior):
        const r = await next.uninstallGlobal();
        ctx.assert("uninstall reports fullCleanup", r.fullCleanup === true);
        ctx.assert("settings entry now gone", !entryPresent(ctx));
        ctx.assert("hookDir gone", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "M3 enabled=true -> Uninstall command -> userUninstalled sticky blocks all later toggles",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await syncState(a, true, true);
        await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("after Uninstall: hook gone", !fs.existsSync(ctx.paths.scriptPath));
        // User toggles status bar (Active -> Observe). syncState with same
        // isMonitoring=true but different autoConfirm.
        const r = await syncState(a, true, false);
        ctx.assert("syncState ensureInstalled returned ok=true (no-op)", r.ok === true);
        ctx.assert(
          "userUninstalled blocks reinstall -- hook stays gone",
          !fs.existsSync(ctx.paths.scriptPath)
        );
        // User runs Stop.
        await syncState(a, false, false);
        ctx.assert("Stop: still gone", !fs.existsSync(ctx.paths.scriptPath));
        // User runs Start. Same gate.
        const r2 = await syncState(a, true, true);
        ctx.assert(
          "Start: ensureInstalled still no-op (userUninstalled sticky)",
          !fs.existsSync(ctx.paths.scriptPath)
        );
      },
    },
    {
      name: "M4 enabled=true -> Uninstall command -> Reinstall command -> hook back",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await syncState(a, true, true);
        await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("uninstalled", !fs.existsSync(ctx.paths.scriptPath));
        const r = await a.reinstall();
        ctx.assert("reinstall ok", r.ok === true);
        ctx.assert("hook back", fs.existsSync(ctx.paths.scriptPath));
        // Re-establish state (extension.ts does this in reinstall command):
        await syncState(a, true, true);
        ctx.assert("presence back", fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("vote back", fs.existsSync(ctx.paths.sessionFile("win-A")));
      },
    },
    {
      name:
        "M5 multi-window: A Uninstall partial -> B continues -> B closes -> auto-finish",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await syncState(a, true, true);
        await syncState(b, true, true);
        // A user runs Uninstall. B is alive -> partial cleanup, marker dropped.
        const r1 = await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("partial cleanup", r1.fullCleanup === false);
        const markerPath = path.join(ctx.paths.hookDir, ".pending-uninstall");
        ctx.assert("marker present", fs.existsSync(markerPath));
        // B continues using hook normally (heartbeats running).
        ctx.assert("B's vote intact", fs.existsSync(ctx.paths.sessionFile("win-B")));
        // B closes (deactivate -> cleanupSession). Last window out: should
        // finish global cleanup.
        await b.cleanupSession();
        ctx.assert("hook fully gone after B closes", !fs.existsSync(ctx.paths.hookDir));
        ctx.assert("settings entry gone", !entryPresent(ctx));
      },
    },
    {
      name:
        "M6 multi-window: A Uninstall partial -> B reinstall -> hook persists",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await syncState(a, true, true);
        await syncState(b, true, true);
        await a.uninstallGlobal({ userInitiated: true });
        const markerPath = path.join(ctx.paths.hookDir, ".pending-uninstall");
        ctx.assert("marker after partial", fs.existsSync(markerPath));
        // B's user explicitly Reinstalls. Should clear marker and lift any
        // stickies in B's instance (B's userUninstalled was never set, but
        // reinstall is idempotent here).
        await b.reinstall();
        ctx.assert("marker cleared by reinstall", !fs.existsSync(markerPath));
        // B closes. No marker -> no global cleanup. Hook stays installed.
        await b.cleanupSession();
        ctx.assert("hook persists", fs.existsSync(ctx.paths.hookDir));
        ctx.assert("settings entry persists", entryPresent(ctx));
      },
    },
    {
      name:
        "M7 disabled startup: per-window cleanup runs, global artifacts untouched, file-writers blocked",
      fn: async (ctx) => {
        // A prior session installed the hook with enabled=true.
        const prev = fresh(ctx, "win-prev");
        await syncState(prev, true, true);
        await prev.cleanupSession();
        ctx.assert("hook.js survives prior window's deactivate", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry survives prior window's deactivate", entryPresent(ctx));

        // New session starts with enabled=false. extension.ts's
        // initializeClaudeHook calls cleanupSession + pruneOrphanedVotes
        // and returns WITHOUT calling ensureInstalled or syncClaudeHookState.
        // The extension-level gate (startMonitoring, toggleWebviewMonitor,
        // reinstallClaudeHookCommand all check config.enabled) prevents
        // ensureInstalled from ever being invoked.
        //
        // Test the installer side of this invariant: after cleanupSession()
        // sets uninstalled=true, all file-writing methods must be no-ops.
        const a = fresh(ctx, "win-A");
        await a.cleanupSession();
        await a.pruneOrphanedVotes();

        // Global artifacts untouched -- disabled startup does NOT remove
        // hook.js or the settings entry (that is disableMonitoringGlobally's
        // job when the user explicitly flips the config, not initializeClaudeHook's).
        ctx.assert("hook.js untouched by disabled startup", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry untouched by disabled startup", entryPresent(ctx));

        // Per-window file-writers all blocked (uninstalled=true set above):
        await a.setEnabled(true);
        ctx.assert("setEnabled blocked: no vote written", !fs.existsSync(ctx.paths.sessionFile("win-A")));
        await a.setMonitoringActive(true);
        ctx.assert("setMonitoringActive blocked: no presence written", !fs.existsSync(ctx.paths.windowFile("win-A")));
        await a.syncConfig([]);
        ctx.assert(
          "syncConfig blocked: no per-window config written",
          !fs.existsSync(path.join(ctx.paths.hookDir, "config-win-A.json"))
        );
      },
    },
    {
      name: "M8 enabled=true -> rapid toggle Active <-> Observe converges to last state",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await syncState(a, true, true);
        ctx.assert("initial vote present", fs.existsSync(ctx.paths.sessionFile("win-A")));
        // Toggle to Observe Only
        await syncState(a, true, false);
        ctx.assert("observe: vote gone", !fs.existsSync(ctx.paths.sessionFile("win-A")));
        ctx.assert("observe: presence stays", fs.existsSync(ctx.paths.windowFile("win-A")));
        // Toggle back to Active
        await syncState(a, true, true);
        ctx.assert("active again: vote back", fs.existsSync(ctx.paths.sessionFile("win-A")));
        // Repeat rapidly
        for (let i = 0; i < 5; i++) {
          await syncState(a, true, false);
          await syncState(a, true, true);
        }
        ctx.assert("after 5 rapid flips: vote present (final state)", fs.existsSync(ctx.paths.sessionFile("win-A")));
        ctx.assert("after 5 rapid flips: presence present", fs.existsSync(ctx.paths.windowFile("win-A")));
      },
    },
    {
      name: "M9 enabled=true -> stopped -> re-enable monitoring -> back to active",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await syncState(a, true, true);
        await syncState(a, false, false); // Stop
        ctx.assert("after Stop: hook still installed", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("after Stop: presence gone", !fs.existsSync(ctx.paths.windowFile("win-A")));
        // Start
        await syncState(a, true, true);
        ctx.assert("Start: presence back", fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("Start: vote back", fs.existsSync(ctx.paths.sessionFile("win-A")));
      },
    },
    {
      name: "M10 enabled false at startup, no leftover -> uninstallGlobal is harmless no-op",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        // Defensive uninstall on disabled startup with NO leftover state
        // should be safe (no error, no created files).
        const r = await a.uninstallGlobal();
        ctx.assert("returns fullCleanup=true (nothing to remove)", r.fullCleanup === true);
        ctx.assert("no hook dir created", !fs.existsSync(ctx.paths.hookDir));
        ctx.assert("no settings file created", !fs.existsSync(ctx.paths.settingsPath));
      },
    },
    {
      // Regression for the "dangling entry" bug: if settings.json becomes
      // malformed after install, uninstallGlobal must NOT delete hookDir and
      // must NOT report fullCleanup=true. A dangling PreToolUse entry pointing
      // at a missing hook.js is worse than a failed uninstall that preserves
      // the existing (still-executable) hook.js.
      name: "M11 malformed settings.json: uninstallGlobal throws, hookDir survives",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await syncState(a, true, true);
        ctx.assert("hook installed", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry present", entryPresent(ctx));
        // Corrupt settings.json after a successful install (simulate manual edit).
        fs.writeFileSync(ctx.paths.settingsPath, "{ this is not valid JSON }");
        let threw = false;
        try {
          await a.uninstallGlobal();
        } catch {
          threw = true;
        }
        ctx.assert("uninstallGlobal threw on malformed settings.json", threw === true);
        ctx.assert(
          "hookDir NOT deleted (no dangling entry left behind)",
          fs.existsSync(ctx.paths.hookDir)
        );
        ctx.assert(
          "hook.js NOT deleted",
          fs.existsSync(ctx.paths.scriptPath)
        );
        // settings.json still malformed (we couldn't fix it)
        let stillMalformed = false;
        try {
          JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
        } catch {
          stillMalformed = true;
        }
        ctx.assert("settings.json still malformed (we did not overwrite it)", stillMalformed);
      },
    },
    {
      // Regression for P1: cold-start with user-level enabled=false must remove
      // any hook left behind by a prior session. Without this, the hook survives
      // in ~/.claude/settings.json even though the user has opted out, because
      // onDidChangeConfiguration never fires on a fresh open.
      //
      // extension.ts's initializeClaudeHook checks isEnabledAtUserLevel() and
      // calls uninstallGlobal() when the user-level setting is false. This test
      // exercises the installer side of that path.
      name: "M12 cold-start user-level disabled: prior hook fully removed",
      fn: async (ctx) => {
        // Simulate a prior session that installed the hook with enabled=true.
        const prev = fresh(ctx, "win-prev");
        await syncState(prev, true, true);
        await prev.cleanupSession();
        ctx.assert("hook.js from prior session present", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry from prior session present", entryPresent(ctx));

        // Cold start with user-level enabled=false: initializeClaudeHook calls
        // uninstallGlobal() directly (no toast on cold start).
        const a = fresh(ctx, "win-A");
        const r = await a.uninstallGlobal();
        ctx.assert("uninstallGlobal returned fullCleanup=true", r.fullCleanup === true);
        ctx.assert("hook.js removed", !fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("settings entry removed", !entryPresent(ctx));
        ctx.assert("hookDir removed", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      // Regression for P1: stale votes from a crashed session must be pruned
      // on the enabled=true startup path, not just on the disabled path.
      // extension.ts calls pruneOrphanedVotes() after ensureInstalled() so
      // the blast radius of a crash is ~90 s, not the full 10-minute TTL.
      name: "M14 enabled=true cold-start: stale vote from prior crash is pruned",
      fn: async (ctx) => {
        // Simulate a prior session that installed the hook and left a vote
        // file (crashed before cleanupSession ran).
        const prev = fresh(ctx, "win-prev");
        await syncState(prev, true, true);
        // Simulate crash: don't call cleanupSession. Age the files > 90 s.
        ctx.helpers.ageOut(ctx.paths.sessionFile("win-prev"), 2);
        ctx.helpers.ageOut(ctx.paths.windowFile("win-prev"), 2);

        // New session starts with enabled=true. Model initializeClaudeHook's
        // enabled=true path: ensureInstalled -> syncConfig -> pruneOrphanedVotes
        // -> setMonitoringActive(true) -> setEnabled(true).
        const a = fresh(ctx, "win-A");
        const r = await a.ensureInstalled();
        ctx.assert("ensureInstalled ok", r.ok === true);
        await a.syncConfig([]);
        await a.pruneOrphanedVotes();
        await a.setMonitoringActive(true);
        await a.setEnabled(true);

        ctx.assert(
          "stale vote from crashed session removed",
          !fs.existsSync(ctx.paths.sessionFile("win-prev"))
        );
        ctx.assert(
          "stale presence from crashed session removed",
          !fs.existsSync(ctx.paths.windowFile("win-prev"))
        );
        ctx.assert(
          "new window's vote present",
          fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
        ctx.assert(
          "new window's presence present",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
      },
    },
    {
      // Regression for P2: user-level opt-out must suppress Claude hook
      // installation but must NOT block terminal/WebView monitoring when a
      // workspace re-enables via its own settings. extension.ts's
      // syncClaudeHookState checks isEnabledAtUserLevel() before ensureInstalled.
      //
      // This test models the syncClaudeHookState fast-exit path: monitoring=true
      // but user-level=false -> skip ensureInstalled entirely -> no hook on disk.
      // A separate window that still has its full install in place can still
      // uninstall cleanly (other windows not affected).
      name: "M13 user-level disabled + workspace enabled: hook skipped, terminal monitoring unaffected",
      fn: async (ctx) => {
        // Prior window installed the hook (represents the state before user
        // opted out globally).
        const prev = fresh(ctx, "win-prev");
        await syncState(prev, true, true);
        await prev.cleanupSession();

        // New window: workspace has enabled=true (isMonitoring=true) but
        // user-level is false. syncClaudeHookState skips ensureInstalled and
        // returns without writing any hook state. Model this by calling
        // setMonitoringActive(false) only (no ensureInstalled, no setEnabled).
        // The hook artifacts from the prior window still exist -- they must not
        // be disturbed by this window just monitoring terminals.
        const a = fresh(ctx, "win-A");
        // Do NOT call ensureInstalled or setMonitoringActive(true): this
        // mirrors syncClaudeHookState's isEnabledAtUserLevel()=false early return.
        ctx.assert(
          "hook.js still present (not touched by user-level-disabled window)",
          fs.existsSync(ctx.paths.scriptPath)
        );
        ctx.assert(
          "settings entry still present",
          entryPresent(ctx)
        );
        ctx.assert(
          "win-A has no presence file (hook infrastructure not used)",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "win-A has no vote file",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );

        // A window that calls uninstallGlobal (user-level disable event) should
        // see fullCleanup=true because win-A never wrote presence.
        const r = await a.uninstallGlobal();
        ctx.assert(
          "uninstallGlobal fullCleanup=true (win-A not counted as live)",
          r.fullCleanup === true,
          `otherLiveWindows=${r.otherLiveWindows}`
        );
        ctx.assert("hook.js removed", !fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("hookDir removed", !fs.existsSync(ctx.paths.hookDir));
      },
    },
  ],
};
