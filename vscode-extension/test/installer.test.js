// ClaudeHookInstaller tests:
// - Multi-window invariants (per-window vote/presence model)
// - P1 paused-window regression (paused window must keep global hook resident)
// - P2 race defense (cleanup vs in-flight tick / setEnabled / syncConfig)
// - Inert-when-disabled regression (ensureInstalled alone must not register presence)
//
// Each test fn receives a `ctx` object built by run.js with:
//   TEST_HOME, BUNDLE, PROJECT, paths.*, helpers.reset/ageOut, assert(label,cond,detail)

const fs = require("fs");
const path = require("path");
const os = require("os");

function loadInstaller(ctx) {
  return require(ctx.BUNDLE).ClaudeHookInstaller;
}

function fresh(ctx, id) {
  const ClaudeHookInstaller = loadInstaller(ctx);
  return new ClaudeHookInstaller(ctx.PROJECT, id, () => {});
}

/**
 * Standard "activate this window for monitoring" sequence: install global
 * artifacts, then mark this window as actively monitoring (presence file +
 * heartbeat). Mirrors what extension.ts does on activate when
 * llmAutoConfirm.enabled=true.
 */
async function activate(installer) {
  await installer.ensureInstalled();
  await installer.setMonitoringActive(true);
}

// Mirror of resources/claude-hook.js hasLiveSession() -- keep threshold synced.
function hookWouldApprove(ctx, maxAgeMs = 10 * 60 * 1000) {
  let entries;
  try {
    entries = fs.readdirSync(ctx.paths.sessionsDir);
  } catch {
    return false;
  }
  const now = Date.now();
  for (const name of entries) {
    let st;
    try {
      st = fs.statSync(`${ctx.paths.sessionsDir}/${name}`);
    } catch {
      continue;
    }
    if (st.isFile() && now - st.mtimeMs <= maxAgeMs) return true;
  }
  return false;
}

module.exports = {
  name:
    "installer (multi-window invariants + P1 paused regression + P2 race defense + inert-when-disabled)",
  tests: [
    {
      name:
        "T1 ensureInstalled drops hook artifacts but does NOT write presence",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const r = await a.ensureInstalled();
        ctx.assert("returns ok", r.ok);
        ctx.assert("hook script exists", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("sessions/ exists", fs.existsSync(ctx.paths.sessionsDir));
        ctx.assert("windows/ exists", fs.existsSync(ctx.paths.windowsDir));
        ctx.assert(
          "settings.json hook entry registered",
          (() => {
            const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
            return s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            );
          })()
        );
        ctx.assert(
          "presence file NOT written by ensureInstalled alone",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "vote file NOT written",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "T_NEW inert: install-only window does NOT block another's full uninstall",
      fn: async (ctx) => {
        // Window B simulates "ensureInstalled was never called" -- the new
        // contract for llmAutoConfirm.enabled=false.
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a); // A is active
        // B does nothing -- as if its config has llmAutoConfirm.enabled=false
        const r = await a.uninstallGlobal();
        ctx.assert("fullCleanup=true", r.fullCleanup === true);
        ctx.assert("otherLiveWindows=0", r.otherLiveWindows === 0);
        ctx.assert("hook dir gone", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T_NEW2 setMonitoringActive(true) writes presence and starts heartbeat",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        ctx.assert(
          "no presence after ensureInstalled alone",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        await a.setMonitoringActive(true);
        ctx.assert(
          "presence written by setMonitoringActive(true)",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
      },
    },
    {
      name: "T_NEW3 setMonitoringActive(false) removes presence AND vote",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        ctx.assert("presence present", fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("vote present", fs.existsSync(ctx.paths.sessionFile("win-A")));
        await a.setMonitoringActive(false);
        ctx.assert(
          "presence gone after stopMonitoring path",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "vote gone after stopMonitoring path",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "T2 setEnabled toggles VOTE only, presence stays",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        ctx.assert("vote present", fs.existsSync(ctx.paths.sessionFile("win-A")));
        ctx.assert(
          "presence still present",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        await a.setEnabled(false);
        ctx.assert("vote removed", !fs.existsSync(ctx.paths.sessionFile("win-A")));
        ctx.assert(
          "presence STILL there (paused != gone)",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
      },
    },
    {
      name: "T3 P1 REGRESSION: paused B + uninstall A => PARTIAL, B can resume",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.setEnabled(true);
        await b.setEnabled(false); // B paused: presence yes, vote no
        ctx.assert("B has presence", fs.existsSync(ctx.paths.windowFile("win-B")));
        ctx.assert(
          "B has no vote",
          !fs.existsSync(ctx.paths.sessionFile("win-B"))
        );
        const r = await a.uninstallGlobal();
        ctx.assert("fullCleanup=false", r.fullCleanup === false);
        ctx.assert(
          "otherLiveWindows=1 (B counted by presence)",
          r.otherLiveWindows === 1
        );
        ctx.assert(
          "settings.json hook entry preserved",
          (() => {
            const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
            return s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            );
          })()
        );
        ctx.assert("hook dir preserved", fs.existsSync(ctx.paths.hookDir));
        await b.setEnabled(true);
        ctx.assert(
          "B's vote file created on resume",
          fs.existsSync(ctx.paths.sessionFile("win-B"))
        );
        ctx.assert("hook would approve via B", hookWouldApprove(ctx));
      },
    },
    {
      name: "T4 last window alone => FULL cleanup",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        const r = await a.uninstallGlobal();
        ctx.assert("fullCleanup=true", r.fullCleanup === true);
        ctx.assert("otherLiveWindows=0", r.otherLiveWindows === 0);
        ctx.assert("hook dir gone", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T5 stale B presence does NOT block A's full cleanup",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        ctx.helpers.ageOut(ctx.paths.windowFile("win-B"));
        const r = await a.uninstallGlobal();
        ctx.assert("fullCleanup=true", r.fullCleanup === true);
        ctx.assert("otherLiveWindows=0", r.otherLiveWindows === 0);
      },
    },
    {
      name: "T6 vote union: A on / B off => approve; both off => defer",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.setEnabled(true);
        await b.setEnabled(false);
        ctx.assert("union approves via A", hookWouldApprove(ctx));
        await a.setEnabled(false);
        ctx.assert("both off => defer", !hookWouldApprove(ctx));
      },
    },
    {
      name: "T7 cleanupSession removes BOTH vote and presence",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        await a.cleanupSession();
        ctx.assert("vote gone", !fs.existsSync(ctx.paths.sessionFile("win-A")));
        ctx.assert(
          "presence gone",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
      },
    },
    {
      name: "T8 A.cleanupSession does NOT disturb B's files",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.setEnabled(true);
        await b.setEnabled(true);
        await a.cleanupSession();
        ctx.assert(
          "B vote intact",
          fs.existsSync(ctx.paths.sessionFile("win-B"))
        );
        ctx.assert(
          "B presence intact",
          fs.existsSync(ctx.paths.windowFile("win-B"))
        );
        ctx.assert("hook still approves via B", hookWouldApprove(ctx));
      },
    },
    {
      name: "T9 post-uninstall sticky: setEnabled / syncConfig become no-ops",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.uninstallGlobal();
        await a.setMonitoringActive(true);
        ctx.assert(
          "setMonitoringActive is no-op",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        await a.setEnabled(true);
        ctx.assert(
          "setEnabled is no-op",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
        await a.syncConfig(["x"]);
        ctx.assert("syncConfig is no-op", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T10 ensureInstalled re-arms after uninstallGlobal",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.uninstallGlobal();
        await a.ensureInstalled();
        await a.setMonitoringActive(true);
        ctx.assert(
          "presence rewritten",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        await a.setEnabled(true);
        ctx.assert(
          "vote works after reinstall",
          fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "T11 isOurEntry strict: foreign hook with substring is preserved",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.claudeDir, { recursive: true });
        fs.writeFileSync(
          ctx.paths.settingsPath,
          JSON.stringify(
            {
              hooks: {
                PreToolUse: [
                  {
                    matcher: ".*",
                    hooks: [
                      {
                        type: "command",
                        command: 'echo "llm-auto-confirm note"',
                      },
                    ],
                  },
                ],
              },
            },
            null,
            2
          )
        );
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        const after = JSON.parse(
          fs.readFileSync(ctx.paths.settingsPath, "utf8")
        );
        ctx.assert(
          "foreign preserved",
          after.hooks.PreToolUse.some((e) =>
            e.hooks?.[0]?.command?.startsWith('echo "')
          )
        );
        ctx.assert(
          "ours added separately",
          after.hooks.PreToolUse.some((e) =>
            e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
          )
        );
        await a.uninstallGlobal();
        const cleaned = JSON.parse(
          fs.readFileSync(ctx.paths.settingsPath, "utf8")
        );
        ctx.assert(
          "foreign STILL there after uninstall",
          cleaned.hooks?.PreToolUse?.some((e) =>
            e.hooks?.[0]?.command?.startsWith('echo "')
          )
        );
      },
    },
    {
      name: "T12 unrelated settings.json keys preserved through install/uninstall",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.claudeDir, { recursive: true });
        fs.writeFileSync(
          ctx.paths.settingsPath,
          JSON.stringify({ model: "claude-sonnet-4", custom: "x" }, null, 2)
        );
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        await a.uninstallGlobal();
        const after = JSON.parse(
          fs.readFileSync(ctx.paths.settingsPath, "utf8")
        );
        ctx.assert("model kept", after.model === "claude-sonnet-4");
        ctx.assert("custom kept", after.custom === "x");
        ctx.assert("hooks key removed", after.hooks === undefined);
      },
    },
    {
      name: "T13 migration: legacy enabled / heartbeat / config.json cleaned up",
      fn: async (ctx) => {
        fs.mkdirSync(ctx.paths.hookDir, { recursive: true });
        fs.writeFileSync(`${ctx.paths.hookDir}/enabled`, "1");
        fs.writeFileSync(`${ctx.paths.hookDir}/heartbeat`, "1");
        // Pre-existing shared config.json from pre-per-window-config era.
        fs.writeFileSync(
          ctx.paths.configPath,
          JSON.stringify({ dangerousCommandPatterns: ["old-pattern"] })
        );
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        ctx.assert(
          "legacy enabled gone",
          !fs.existsSync(`${ctx.paths.hookDir}/enabled`)
        );
        ctx.assert(
          "legacy heartbeat gone",
          !fs.existsSync(`${ctx.paths.hookDir}/heartbeat`)
        );
        ctx.assert(
          "legacy config.json gone",
          !fs.existsSync(ctx.paths.configPath)
        );
      },
    },
    {
      name: "T14 mixed paused-fresh + paused-stale: PARTIAL count=1",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        const c = fresh(ctx, "win-C");
        await activate(a);
        await activate(b);
        await activate(c);
        await b.setEnabled(false);
        await c.setEnabled(false);
        ctx.helpers.ageOut(ctx.paths.windowFile("win-C"));
        const r = await a.uninstallGlobal();
        ctx.assert("fullCleanup=false", r.fullCleanup === false);
        ctx.assert(
          "otherLiveWindows=1 (B counted, C ignored as stale)",
          r.otherLiveWindows === 1
        );
      },
    },
    {
      name: "R1 P2 race: 50× concurrent setEnabled + cleanupSession leave 0 ghosts",
      fn: async (ctx) => {
        let ghosts = 0;
        for (let i = 0; i < 50; i++) {
          ctx.helpers.reset();
          const a = fresh(ctx, "win-A");
          await activate(a);
          await Promise.all([a.setEnabled(true), a.cleanupSession()]);
          if (
            fs.existsSync(ctx.paths.sessionFile("win-A")) ||
            fs.existsSync(ctx.paths.windowFile("win-A"))
          )
            ghosts++;
        }
        ctx.assert(
          `0 ghosts across 50 iterations`,
          ghosts === 0,
          `saw ${ghosts}`
        );
      },
    },
    {
      name: "R2 P2 race: 50× concurrent syncConfig + uninstallGlobal leave 0 hookDir leaks",
      fn: async (ctx) => {
        let leaks = 0;
        for (let i = 0; i < 50; i++) {
          ctx.helpers.reset();
          const a = fresh(ctx, "win-A");
          await activate(a);
          await Promise.all([a.syncConfig(["x"]), a.uninstallGlobal()]);
          if (fs.existsSync(ctx.paths.hookDir)) leaks++;
        }
        ctx.assert(`0 leaks across 50 iterations`, leaks === 0, `saw ${leaks}`);
      },
    },
    {
      name: "R4 P2 race: in-flight heartbeat tick vs setMonitoringActive(false) leaves no ghost",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        await a.setMonitoringActive(true);
        await a.setEnabled(true);
        // Directly invoke a heartbeat tick (reflection -- field is `private`
        // in TS but plain at runtime). This simulates the race where a timer
        // callback has already entered tickHeartbeat synchronously and is
        // mid-await when setMonitoringActive(false) is called.
        const tickPromise = a["tickHeartbeat"]();
        const stopPromise = a.setMonitoringActive(false);
        await Promise.all([tickPromise, stopPromise]);
        ctx.assert(
          "no presence ghost after concurrent tick+stop",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "no vote ghost after concurrent tick+stop",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "R5 P2 race: 30× tick + setMonitoringActive(false) chaos leaves 0 ghosts",
      fn: async (ctx) => {
        let ghosts = 0;
        for (let i = 0; i < 30; i++) {
          ctx.helpers.reset();
          const a = fresh(ctx, "win-A");
          await a.ensureInstalled();
          await a.setMonitoringActive(true);
          // Schedule multiple ticks then immediately stop monitoring
          const ops = [];
          for (let j = 0; j < 3; j++) ops.push(a["tickHeartbeat"]());
          ops.push(a.setMonitoringActive(false));
          await Promise.all(ops);
          if (
            fs.existsSync(ctx.paths.windowFile("win-A")) ||
            fs.existsSync(ctx.paths.sessionFile("win-A"))
          )
            ghosts++;
        }
        ctx.assert(
          `0 ghosts across 30 chaos iterations`,
          ghosts === 0,
          `saw ${ghosts}`
        );
      },
    },
    {
      name: "T_NEW5 partial uninstall in A + re-enable in A => A re-joins monitoring",
      fn: async (ctx) => {
        // Reproduces the multi-window scenario:
        // 1) A and B both monitoring
        // 2) A flips llmAutoConfirm.enabled=false -> uninstallGlobal returns
        //    PARTIAL (B alive). A's sticky uninstalled is set; settings.json
        //    + hook.js survive.
        // 3) A flips llmAutoConfirm.enabled=true -> must clear sticky and
        //    re-establish presence/vote.
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.setEnabled(true);
        await b.setEnabled(true);

        // Step 2: A's config-disable path
        const r = await a.uninstallGlobal();
        ctx.assert("A's uninstall returns PARTIAL", r.fullCleanup === false);
        ctx.assert(
          "settings.json hook entry still there (B uses it)",
          (() => {
            const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
            return s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            );
          })()
        );
        ctx.assert("hook.js still there", fs.existsSync(ctx.paths.scriptPath));

        // Step 3: A re-enables -- mirrors syncClaudeHookState's monitoring=true
        // path: ensureInstalled (must clear sticky even though hook.js is
        // there) + syncConfig + setMonitoringActive(true) + setEnabled(true).
        const r2 = await a.ensureInstalled();
        ctx.assert("re-install returns ok", r2.ok);
        await a.syncConfig([]);
        await a.setMonitoringActive(true);
        await a.setEnabled(true);
        ctx.assert(
          "A's presence written after re-enable",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "A's vote written after re-enable",
          fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
        ctx.assert("hook would approve via A again", hookWouldApprove(ctx));
      },
    },
    {
      name: "T_NEW6 user-initiated uninstall is durable: subsequent ensureInstalled / setMonitoringActive are no-ops",
      fn: async (ctx) => {
        // Reproduces the new P2 review concern:
        // 1) User runs Uninstall command (userInitiated=true)
        // 2) User toggles status bar / runs Start later
        // The toggle/Start path normally calls ensureInstalled +
        // setMonitoringActive(true) + setEnabled(true). Without the
        // userUninstalled sticky, those would silently recreate everything,
        // undoing the explicit Uninstall.
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("hook script gone after user uninstall", !fs.existsSync(ctx.paths.scriptPath));
        // Simulate Start path
        const r = await a.ensureInstalled();
        ctx.assert("ensureInstalled is a no-op (returns ok)", r.ok === true);
        ctx.assert(
          "ensureInstalled did NOT recreate hook.js",
          !fs.existsSync(ctx.paths.scriptPath)
        );
        await a.setMonitoringActive(true);
        ctx.assert(
          "setMonitoringActive did NOT recreate presence",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        await a.setEnabled(true);
        ctx.assert(
          "setEnabled did NOT recreate vote",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
        await a.syncConfig(["foo"]);
        ctx.assert(
          "syncConfig did NOT recreate per-window config",
          !fs.existsSync(ctx.paths.windowConfigFile("win-A"))
        );
      },
    },
    {
      name: "T_NEW7 reinstall() lifts userUninstalled and brings the hook back",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("post-uninstall: hook gone", !fs.existsSync(ctx.paths.scriptPath));

        // Reinstall command path
        const r = await a.reinstall();
        ctx.assert("reinstall returns ok", r.ok === true);
        ctx.assert("hook script back", fs.existsSync(ctx.paths.scriptPath));
        await a.setMonitoringActive(true);
        await a.setEnabled(true);
        ctx.assert(
          "presence back after reinstall",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "vote back after reinstall",
          fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "T_NEW8 config-disable (userInitiated=false) is recoverable by ensureInstalled",
      fn: async (ctx) => {
        // Distinguishes the config-flip path (T_NEW5 semantics) from the
        // user-uninstall path (T_NEW6). Same uninstallGlobal call, different
        // option => different durability.
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        await a.uninstallGlobal({ userInitiated: false }); // config flip
        ctx.assert("hook gone after config disable", !fs.existsSync(ctx.paths.scriptPath));
        const r = await a.ensureInstalled();
        ctx.assert("ensureInstalled brings it back", r.ok === true && fs.existsSync(ctx.paths.scriptPath));
        await a.setMonitoringActive(true);
        await a.setEnabled(true);
        ctx.assert(
          "monitoring works after re-enable",
          fs.existsSync(ctx.paths.windowFile("win-A")) &&
            fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "T_NEW13 P2-A: partial uninstall marker => last window's cleanupSession finishes the cleanup",
      fn: async (ctx) => {
        const path = require("path");
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        // A runs Uninstall while B is alive => partial cleanup, marker dropped.
        const r1 = await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("partial cleanup", r1.fullCleanup === false);
        const markerPath = path.join(ctx.paths.hookDir, ".pending-uninstall");
        ctx.assert("pending-uninstall marker written", fs.existsSync(markerPath));
        ctx.assert("hookDir still there (B uses it)", fs.existsSync(ctx.paths.hookDir));
        // A's window file is gone (uninstallGlobal removed it). B's still there.
        ctx.assert("A's presence file gone", !fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("B's presence file still there", fs.existsSync(ctx.paths.windowFile("win-B")));
        // Now B closes (deactivate). Its cleanupSession should detect the
        // marker + that no other windows are alive, and finish the global
        // uninstall.
        await b.cleanupSession();
        ctx.assert("hookDir gone after B closes", !fs.existsSync(ctx.paths.hookDir));
        if (fs.existsSync(ctx.paths.settingsPath)) {
          const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8") || "{}");
          ctx.assert(
            "settings.json hook entry removed",
            !s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            )
          );
        }
      },
    },
    {
      name: "T_NEW14 P2-A: A closes first, then B (last) finishes the partial uninstall",
      fn: async (ctx) => {
        const path = require("path");
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.uninstallGlobal({ userInitiated: true });
        const markerPath = path.join(ctx.paths.hookDir, ".pending-uninstall");
        ctx.assert("marker present after partial", fs.existsSync(markerPath));
        // A closes first. B is still alive, so A's cleanupSession should NOT
        // finish the global cleanup yet.
        await a.cleanupSession();
        ctx.assert("hookDir still there after A closes (B alive)", fs.existsSync(ctx.paths.hookDir));
        ctx.assert("marker still there", fs.existsSync(markerPath));
        // Then B closes. Now the last one out finishes cleanup.
        await b.cleanupSession();
        ctx.assert("hookDir finally gone", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T_NEW15 P2-A: reinstall() before last close clears the marker, hook persists",
      fn: async (ctx) => {
        const path = require("path");
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.uninstallGlobal({ userInitiated: true });
        const markerPath = path.join(ctx.paths.hookDir, ".pending-uninstall");
        ctx.assert("marker present", fs.existsSync(markerPath));
        // B's user explicitly reinstalls -- this overrides the pending uninstall.
        await b.reinstall();
        ctx.assert("marker cleared by reinstall", !fs.existsSync(markerPath));
        // Now B closes (last alive). Without marker, full-cleanup path
        // should NOT trigger; hookDir stays for next time.
        await b.cleanupSession();
        ctx.assert("hookDir kept (no pending uninstall)", fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T_NEW16 P2-A: config-disable (userInitiated=false) does NOT drop the marker",
      fn: async (ctx) => {
        const path = require("path");
        // Config-disable is not the user-explicit uninstall command. It
        // should NOT leave a pending-uninstall marker (otherwise re-enable
        // wouldn't be a clean back-to-installed state).
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.uninstallGlobal({ userInitiated: false });
        const markerPath = path.join(ctx.paths.hookDir, ".pending-uninstall");
        ctx.assert("no marker on config-disable partial cleanup", !fs.existsSync(markerPath));
        // B closes -- without marker, full cleanup should NOT trigger.
        await b.cleanupSession();
        // hookDir disposition: with no marker AND no live windows, current
        // cleanupSession DOES leave hookDir alone (no global cleanup). The
        // hook stays installed for next session, which matches "config flip
        // is reversible" semantics.
        ctx.assert("hookDir kept (config-disable is reversible)", fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T_NEW17 P2: stop-then-disable scenario tears down the hook (state-matrix gap)",
      fn: async (ctx) => {
        // Reproduces the orchestrator-level bug: user runs Stop first, then
        // sets llmAutoConfirm.enabled=false. The previous gating
        // `config.enabled !== isMonitoring` would skip the disable branch
        // (both already false). At the installer level, this is just
        // verifying that a stopped-but-installed window can still be torn
        // down by an explicit uninstallGlobal call -- which is what the
        // fixed orchestrator now does.
        const a = fresh(ctx, "win-A");
        await activate(a);
        await a.setEnabled(true);
        // Simulate Stop: setMonitoringActive(false) (this matches what
        // syncClaudeHookState does when isMonitoring goes false).
        await a.setMonitoringActive(false);
        ctx.assert("after Stop: presence gone", !fs.existsSync(ctx.paths.windowFile("win-A")));
        ctx.assert("after Stop: hook still installed", fs.existsSync(ctx.paths.scriptPath));
        // Simulate the now-fixed onDidChangeConfiguration disable branch
        // running unconditionally on config flip:
        const r = await a.uninstallGlobal();
        ctx.assert("uninstall fullCleanup", r.fullCleanup === true);
        ctx.assert("hook dir gone", !fs.existsSync(ctx.paths.hookDir));
        // settings.json hook entry should also be removed.
        if (fs.existsSync(ctx.paths.settingsPath)) {
          const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8") || "{}");
          ctx.assert(
            "settings.json hook entry gone",
            !s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            )
          );
        }
      },
    },
    {
      name: "T_NEW18 leftover hook from previous session: uninstallGlobal() removes artifacts when called explicitly",
      fn: async (ctx) => {
        // Simulate a previous session that installed the hook and then
        // deactivated normally. Hook artifacts remain on disk.
        const previousSession = fresh(ctx, "win-A");
        await activate(previousSession);
        await previousSession.setEnabled(true);
        await previousSession.cleanupSession();
        ctx.assert(
          "hook dir survives normal deactivate",
          fs.existsSync(ctx.paths.hookDir)
        );
        ctx.assert(
          "settings.json entry survives",
          (() => {
            const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
            return s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            );
          })()
        );
        // A new installer instance can detect the leftover and clean it up
        // when explicitly told to (e.g. via Uninstall command or a
        // config-disable flow that calls uninstallGlobal()).
        const nextSession = fresh(ctx, "win-B");
        ctx.assert("isInstalled() detects leftover", nextSession.isInstalled());
        const r = await nextSession.uninstallGlobal();
        ctx.assert("uninstall fullCleanup", r.fullCleanup === true);
        ctx.assert("hook dir gone", !fs.existsSync(ctx.paths.hookDir));
      },
    },
    {
      name: "T_NEW10 P1-B: 50x concurrent ensureInstalled + uninstallGlobal({userInitiated:true}) leaves NO files",
      fn: async (ctx) => {
        let leftovers = 0;
        for (let i = 0; i < 50; i++) {
          ctx.helpers.reset();
          const a = fresh(ctx, "win-A");
          // Race them. The user expectation is "uninstalled" (since
          // userInitiated=true). Even if ensureInstalled finishes after
          // uninstallGlobal returns, the uninstallGen bump must cause it
          // to abort without writing files.
          await Promise.all([
            a.ensureInstalled(),
            a.uninstallGlobal({ userInitiated: true }),
          ]);
          // After a user-initiated uninstall in a single-window setup,
          // hookDir should be gone (full cleanup, no other live windows).
          if (
            fs.existsSync(ctx.paths.hookDir) ||
            fs.existsSync(ctx.paths.scriptPath) ||
            fs.existsSync(ctx.paths.windowFile("win-A")) ||
            fs.existsSync(ctx.paths.sessionFile("win-A"))
          ) {
            leftovers++;
          }
        }
        ctx.assert(
          `0 leftover files across 50 iterations`,
          leftovers === 0,
          `saw ${leftovers}`
        );
      },
    },
    {
      name: "T_NEW11 P1-B: 50x concurrent ensureInstalled + config-disable also leaves NO files",
      fn: async (ctx) => {
        // userInitiated=false path: same race, slightly different gates
        // (uninstalled bumped but userUninstalled NOT). The uninstallGen
        // check still saves us; ensureInstalled aborts and uninstallGlobal's
        // full cleanup runs.
        let leftovers = 0;
        for (let i = 0; i < 50; i++) {
          ctx.helpers.reset();
          const a = fresh(ctx, "win-A");
          await Promise.all([
            a.ensureInstalled(),
            a.uninstallGlobal({ userInitiated: false }),
          ]);
          if (
            fs.existsSync(ctx.paths.hookDir) ||
            fs.existsSync(ctx.paths.scriptPath) ||
            fs.existsSync(ctx.paths.windowFile("win-A")) ||
            fs.existsSync(ctx.paths.sessionFile("win-A"))
          ) {
            leftovers++;
          }
        }
        ctx.assert(
          `0 leftover files across 50 iterations`,
          leftovers === 0,
          `saw ${leftovers}`
        );
      },
    },
    {
      name: "T_NEW12 P1-B: ensureInstalled does NOT clear sticky if uninstall fired during run",
      fn: async (ctx) => {
        // Direct test of the gen-check semantic: simulate a concurrent
        // uninstall by bumping the gen mid-flight. Even though the visible
        // API doesn't expose this, we use reflection to verify the invariant.
        const a = fresh(ctx, "win-A");
        // Drive a fully-installed state, then run a partial uninstall (sets
        // uninstalled=true, bumps gen).
        await a.ensureInstalled();
        await a.uninstallGlobal({ userInitiated: false });
        ctx.assert("post-uninstall: uninstalled flag is true", a["uninstalled"] === true);
        // Now simulate concurrent uninstall during ensureInstalled by bumping
        // gen mid-call. To do this deterministically, we patch resolveNodePath
        // to bump gen during its await.
        const originalResolve = a["resolveNodePath"].bind(a);
        a["resolveNodePath"] = async function () {
          const result = await originalResolve();
          // Simulate a concurrent uninstall AFTER the await but BEFORE
          // ensureInstalled writes files.
          a["uninstallGen"]++;
          a["uninstalled"] = true;
          return result;
        };
        const r = await a.ensureInstalled();
        // ensureInstalled should detect the gen change and abort.
        ctx.assert(
          "ensureInstalled returned ok=true (no-op due to race)",
          r.ok === true && r.scriptChanged === false && r.settingsChanged === false
        );
        ctx.assert(
          "uninstalled flag NOT cleared (race detected)",
          a["uninstalled"] === true
        );
      },
    },
    {
      name: "T_NEW9 settings.json hook command embeds an absolute node path (not bare 'node')",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
        // Find our entry: either direct command (includes scriptPath) or shim path
        const shimCandidate = path.join(ctx.paths.hookDir, "claude-hook-runner.cmd");
        const ourEntry = s.hooks?.PreToolUse?.find((e) =>
          e.hooks?.some(
            (h) =>
              h.command?.includes(ctx.paths.scriptPath) ||
              h.command === shimCandidate
          )
        );
        ctx.assert("our entry found", !!ourEntry);
        const cmd = ourEntry.hooks[0].command;
        if (process.platform === "win32") {
          ctx.assert("Windows: no & prefix", !cmd.startsWith("& "), `cmd=${cmd}`);
          if (cmd === shimCandidate) {
            // Shim path: node was in a space-containing directory.
            ctx.assert("shim path has no spaces", !cmd.includes(" "), `cmd=${cmd}`);
            ctx.assert("shim path is absolute", /^[A-Za-z]:[\\/]/.test(cmd), `cmd=${cmd}`);
            ctx.assert("shim file exists on disk", fs.existsSync(cmd), `cmd=${cmd}`);
          } else {
            // Direct invocation: node path has no spaces, unquoted absolute path.
            ctx.assert("Windows: node ref is not quoted", !cmd.startsWith('"'), `cmd=${cmd}`);
            const nodeRef = cmd.slice(0, cmd.indexOf('"')).trim();
            const isBare = nodeRef === "node" || nodeRef === "node.exe";
            const isAbsNoSpaces = /^[A-Za-z]:[\\/]\S+$/.test(nodeRef);
            ctx.assert(
              "node ref is bare 'node' or unquoted absolute path without spaces",
              isBare || isAbsNoSpaces,
              `nodeRef='${nodeRef}'`
            );
            if (isAbsNoSpaces) {
              ctx.assert(
                "absolute node path exists on disk",
                fs.existsSync(nodeRef),
                `nodeRef=${nodeRef}`
              );
            }
            const scriptPart = cmd.slice(cmd.indexOf('"'));
            const ms = scriptPart.match(/^"([^"]+)"$/);
            ctx.assert("script part is a single quoted token", !!ms, `scriptPart=${scriptPart}`);
            if (ms) {
              ctx.assert(
                "script path is absolute",
                /^[A-Za-z]:[\\/]/.test(ms[1]),
                `scriptPath=${ms[1]}`
              );
            }
          }
        } else {
          // POSIX: "quoted-node" "quoted-script"
          const m = cmd.match(/^"([^"]+)"\s+"([^"]+)"$/);
          ctx.assert('command shape: "node" "script"', !!m, `cmd=${cmd}`);
          if (m) {
            const nodeAbs = m[1];
            ctx.assert(
              "node path is absolute",
              nodeAbs.startsWith("/"),
              `nodeAbs=${nodeAbs}`
            );
            ctx.assert(
              "absolute node path exists on disk",
              fs.existsSync(nodeAbs),
              `nodeAbs=${nodeAbs}`
            );
          }
        }
      },
    },
    {
      name: "T_NEW9b (Windows) node-in-spaces-path: .cmd shim generated, absolute path preserved",
      fn: async (ctx) => {
        if (process.platform !== "win32") return; // shim logic is Windows-only
        const a = fresh(ctx, "win-A");
        // Stub resolveNodePath to simulate node installed at a path with spaces
        // ("C:\Program Files\"). Cannot pre-set this.nodePath directly because
        // ensureInstalled() now clears the cache before calling resolveNodePath
        // (to handle nvm/Volta switches where the old binary is gone).
        const fakeNode = "C:\\Program Files\\nodejs\\node.exe";
        a["resolveNodePath"] = async () => fakeNode;
        await a.ensureInstalled();

        // .cmd shim must exist in hookDir (no spaces)
        const shimPath = path.join(ctx.paths.hookDir, "claude-hook-runner.cmd");
        ctx.assert("shim file created", fs.existsSync(shimPath), `hookDir=${ctx.paths.hookDir}`);
        const shim = fs.readFileSync(shimPath, "utf8");
        ctx.assert("shim starts with @ (echo suppressed)", shim.startsWith("@"), `shim=${shim}`);
        ctx.assert("shim quotes node path", shim.includes(`"${fakeNode}"`), `shim=${shim}`);
        ctx.assert(
          "shim quotes hook script path",
          shim.includes(`"${ctx.paths.scriptPath}"`),
          `shim=${shim}`
        );

        // settings.json must reference the shim path, not wrap it in quotes
        const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
        const entry = s.hooks?.PreToolUse?.find((e) =>
          e.hooks?.some((h) => h.command === shimPath)
        );
        ctx.assert(
          "settings.json command is the unquoted shim path",
          !!entry,
          `commands=${JSON.stringify(s.hooks?.PreToolUse?.map((e) => e.hooks?.[0]?.command))}`
        );

        // isOurEntry must recognise the shim-based entry (for correct
        // uninstall / upgrade recognition).
        ctx.assert(
          "isOurEntry recognises shim-based entry",
          a["isOurEntry"](entry)
        );

        // Full uninstall removes hookDir (and the shim inside it).
        await a.uninstallGlobal({ userInitiated: true });
        ctx.assert("shim removed after full uninstall", !fs.existsSync(shimPath));
      },
    },
    {
      name: "T_NEW9c (Windows) both-spaces-path: .ps1 shim generated, settings command uses powershell -File",
      fn: async (ctx) => {
        if (process.platform !== "win32") return; // shim logic is Windows-only
        const spaceHome = path.join(os.tmpdir(), "test home spaces");
        // run.js already patches os.homedir to TEST_HOME; save that to restore later.
        const origHomedir = os.homedir;
        os.homedir = () => spaceHome;
        try {
          const a = fresh(ctx, "win-A");
          // Paths are captured at construction time; restore immediately.
          os.homedir = origHomedir;
          const fakeNode = "C:\\Program Files\\nodejs\\node.exe";
          // Stub resolveNodePath for the same reason as T_NEW9b: ensureInstalled()
          // clears the nodePath cache before discovery to handle stale binaries.
          a["resolveNodePath"] = async () => fakeNode;

          const spaceHookDir = path.join(spaceHome, ".claude", "llm-auto-confirm");
          const spaceSettingsPath = path.join(spaceHome, ".claude", "settings.json");
          const ps1Path = path.join(spaceHookDir, "claude-hook-runner.ps1");

          await a.ensureInstalled();

          // .ps1 shim must exist because both node and hookDir have spaces
          ctx.assert("ps1 shim file created", fs.existsSync(ps1Path), `hookDir=${spaceHookDir}`);
          const shim = fs.readFileSync(ps1Path, "utf8");
          ctx.assert(
            "shim starts with & ' (PowerShell call operator)",
            shim.startsWith("& '"),
            `shim=${shim}`
          );
          ctx.assert(
            "shim single-quotes node path",
            shim.includes(`'${fakeNode}'`),
            `shim=${shim}`
          );

          // settings.json must use powershell -File, NOT bare node or quoted exe
          const s = JSON.parse(fs.readFileSync(spaceSettingsPath, "utf8"));
          const entry = s.hooks?.PreToolUse?.find((e) =>
            e.hooks?.some(
              (h) => typeof h.command === "string" && h.command.includes(ps1Path)
            )
          );
          ctx.assert(
            "settings.json command references ps1 shim",
            !!entry,
            `commands=${JSON.stringify(s.hooks?.PreToolUse?.map((e) => e.hooks?.[0]?.command))}`
          );
          const cmd = entry?.hooks?.[0]?.command ?? "";
          ctx.assert(
            "command starts with powershell -NoProfile -NonInteractive -File",
            cmd.startsWith("powershell -NoProfile -NonInteractive -File"),
            `cmd=${cmd}`
          );
          ctx.assert(
            "command does not fall back to bare 'node'",
            !cmd.startsWith("node ") && cmd !== "node",
            `cmd=${cmd}`
          );

          // isOurEntry must recognise the ps1-based command shape
          ctx.assert("isOurEntry recognises ps1-based entry", a["isOurEntry"](entry));

          // Full uninstall removes hookDir (and the shim inside it)
          await a.uninstallGlobal({ userInitiated: true });
          ctx.assert("ps1 shim removed after full uninstall", !fs.existsSync(ps1Path));
          ctx.assert("hookDir removed after full uninstall", !fs.existsSync(spaceHookDir));
        } finally {
          os.homedir = origHomedir;
          try { fs.rmSync(spaceHome, { recursive: true, force: true }); } catch {}
        }
      },
    },
    {
      name: "T_NEW9d hook installs correctly when nodePath is pre-set (resolveNodePath bypassed)",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        // Pre-seed nodePath so resolveNodePath() returns early. This covers
        // any caller that sets nodePath directly (e.g. tests, future
        // integrations). process.execPath is a real node binary in the test
        // runner, so the install should succeed end-to-end.
        a["nodePath"] = process.execPath;
        const r = await a.ensureInstalled();
        ctx.assert("ok=true with pre-set nodePath", r.ok, r.error ?? "");
        ctx.assert("nodePath retained", a["nodePath"] === process.execPath);
        ctx.assert("hook script written to disk", fs.existsSync(ctx.paths.scriptPath));
        const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
        ctx.assert(
          "hook entry present in settings.json",
          !!s.hooks?.PreToolUse?.find((e) => a["isOurEntry"](e))
        );
      },
    },
    {
      name: "T_FP stale node binary bypasses fast path and triggers full reinstall",
      fn: async (ctx) => {
        // Normal install with the real node binary.
        const prev = fresh(ctx, "win-prev");
        prev["nodePath"] = process.execPath;
        await prev.ensureInstalled();
        await prev.cleanupSession();

        // Corrupt the settings entry to reference a non-existent node path.
        // Use POSIX-style quoting so extractNodePath can parse it regardless
        // of platform.
        const fakeNode = "/absolutely/not/node";
        const settingsRaw = fs.readFileSync(ctx.paths.settingsPath, "utf8");
        const settings = JSON.parse(settingsRaw);
        const entry = settings.hooks.PreToolUse.find((e) =>
          e.hooks?.some((h) => typeof h.command === "string" && h.command.includes(ctx.paths.scriptPath))
        );
        const hook = entry.hooks.find((h) => h.command?.includes(ctx.paths.scriptPath));
        // Replace command with POSIX-style fake: extractNodePath will parse
        // the leading-quoted token and return the stale (non-existent) path.
        hook.command = `"${fakeNode}" "${ctx.paths.scriptPath}"`;
        fs.writeFileSync(ctx.paths.settingsPath, JSON.stringify(settings, null, 2) + "\n");

        // New session: resolveNodePath is stubbed (simulates node found on PATH).
        const a = fresh(ctx, "win-A");
        a["resolveNodePath"] = async () => process.execPath;

        const r = await a.ensureInstalled();
        ctx.assert("ok=true after full reinstall triggered by stale node", r.ok === true, r.error ?? "");
        ctx.assert("settings entry updated (stale path removed)", r.settingsChanged === true);

        // Verify the entry no longer references the stale path.
        const newSettings = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
        const newEntry = newSettings.hooks.PreToolUse.find((e) =>
          e.hooks?.some((h) => typeof h.command === "string" && h.command.includes(ctx.paths.scriptPath))
        );
        const newCmd = newEntry?.hooks?.find((h) => typeof h.command === "string")?.command ?? "";
        ctx.assert(
          "settings command no longer references stale node path",
          !newCmd.includes(fakeNode),
          `cmd=${newCmd}`
        );
      },
    },
    {
      name: "T_FP2 same-instance cached nodePath cleared before full reinstall (nvm/Volta switch)",
      fn: async (ctx) => {
        // Simulate the nvm-switch scenario: same installer instance did a
        // successful install (which set this.nodePath), then the node binary
        // was replaced. isFullyInstalled() correctly detects the stale binary
        // and returns false, but without the fix resolveNodePath() would
        // immediately return the stale this.nodePath cache.
        const a = fresh(ctx, "win-A");
        // First install: uses a pre-set nodePath (simulates prior activation).
        a["nodePath"] = process.execPath;
        await a.ensureInstalled();

        // Now corrupt settings to reference a non-existent node binary,
        // simulating what happens after an nvm version switch:
        //   - settings.json still references the old (now-gone) binary
        //   - this.nodePath cache still holds the old path
        const fakeNode = "/absolutely/not/node";
        const settingsRaw = fs.readFileSync(ctx.paths.settingsPath, "utf8");
        const settings = JSON.parse(settingsRaw);
        const entry = settings.hooks.PreToolUse.find((e) =>
          e.hooks?.some((h) => typeof h.command === "string" && h.command.includes(ctx.paths.scriptPath))
        );
        const hook = entry.hooks.find((h) => h.command?.includes(ctx.paths.scriptPath));
        hook.command = `"${fakeNode}" "${ctx.paths.scriptPath}"`;
        fs.writeFileSync(ctx.paths.settingsPath, JSON.stringify(settings, null, 2) + "\n");
        // Manually set the instance cache to the same stale path so we
        // reproduce the exact failure mode: resolveNodePath() would return it
        // directly without this fix.
        a["nodePath"] = fakeNode;

        // Call ensureInstalled() again on the SAME instance (as syncClaudeHookState
        // does after a Stop+Start while VS Code stays open).
        // resolveNodePath is NOT stubbed: it must discover the real node via PATH.
        const r = await a.ensureInstalled();
        ctx.assert("ok=true after clearing stale cache", r.ok === true, r.error ?? "");
        ctx.assert("settings entry updated (settingsChanged=true)", r.settingsChanged === true);

        const newSettings = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
        const newEntry = newSettings.hooks.PreToolUse.find((e) =>
          e.hooks?.some((h) => typeof h.command === "string" && h.command.includes(ctx.paths.scriptPath))
        );
        const newCmd = newEntry?.hooks?.find((h) => typeof h.command === "string")?.command ?? "";
        ctx.assert(
          "settings command no longer references stale node path",
          !newCmd.includes(fakeNode),
          `cmd=${newCmd}`
        );
        ctx.assert(
          "nodePath cache updated to real node",
          a["nodePath"] !== fakeNode && !!a["nodePath"],
          `nodePath=${a["nodePath"]}`
        );
      },
    },
    {
      name: "T_NEW19 already-installed hook: ensureInstalled succeeds even when node is not on PATH",
      fn: async (ctx) => {
        // Simulate: hook was installed in a previous VS Code session (node was
        // on PATH then). Now VS Code is launched from the GUI (no shell PATH),
        // so resolveNodePath() returns null. The fast path in ensureInstalled()
        // should detect that hook.js and the settings entry are already current
        // and return ok=true WITHOUT calling resolveNodePath.
        const prev = fresh(ctx, "win-prev");
        prev["nodePath"] = process.execPath;
        await prev.ensureInstalled();
        await prev.cleanupSession();

        // New session: resolveNodePath is stubbed to return null.
        const a = fresh(ctx, "win-A");
        a["resolveNodePath"] = async () => null;

        const r = await a.ensureInstalled();
        ctx.assert("ok=true despite no node on PATH", r.ok === true, r.error ?? "");
        ctx.assert("uninstalled cleared (fast path)", a["uninstalled"] === false);

        // Monitoring still works: presence and vote files can be written.
        await a.setMonitoringActive(true);
        await a.setEnabled(true);
        ctx.assert(
          "presence file written",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        ctx.assert(
          "vote file written",
          fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
      },
    },
    {
      name: "T_NEW4 config-disable path (uninstallGlobal) removes everything when last window",
      fn: async (ctx) => {
        // Simulate: window started with enabled=true, did some monitoring,
        // then user flipped enabled=false in config -> extension.ts calls
        // uninstallGlobal. Verify that all artifacts are gone.
        const a = fresh(ctx, "win-A");
        await a.ensureInstalled();
        await a.setMonitoringActive(true);
        await a.setEnabled(true);
        ctx.assert("hook script exists pre-disable", fs.existsSync(ctx.paths.scriptPath));
        ctx.assert(
          "presence exists pre-disable",
          fs.existsSync(ctx.paths.windowFile("win-A"))
        );
        // The runtime path the config-disable triggers in extension.ts:
        const r = await a.uninstallGlobal();
        ctx.assert("fullCleanup=true", r.fullCleanup === true);
        ctx.assert("hook script removed", !fs.existsSync(ctx.paths.scriptPath));
        ctx.assert("hook dir removed", !fs.existsSync(ctx.paths.hookDir));
        // And settings.json's hook entry removed
        if (fs.existsSync(ctx.paths.settingsPath)) {
          const s = JSON.parse(fs.readFileSync(ctx.paths.settingsPath, "utf8"));
          ctx.assert(
            "settings.json hook entry removed",
            !s.hooks?.PreToolUse?.some((e) =>
              e.hooks?.some((h) => h.command?.includes(ctx.paths.scriptPath))
            )
          );
        }
      },
    },
    {
      name: "T_CFG2 setMonitoringActive(false) removes per-window config (stopped window no longer bleeds patterns)",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.syncConfig(["npm publish"]);
        await b.syncConfig([]);
        ctx.assert("A config present while monitoring", fs.existsSync(ctx.paths.windowConfigFile("win-A")));
        // A stops monitoring (clicks Stop)
        await a.setMonitoringActive(false);
        ctx.assert("A config removed after Stop", !fs.existsSync(ctx.paths.windowConfigFile("win-A")));
        ctx.assert("B config untouched", fs.existsSync(ctx.paths.windowConfigFile("win-B")));
        // A resumes -- syncConfig must be called before setMonitoringActive(true),
        // mirroring what syncClaudeHookState does.
        await a.syncConfig(["npm publish"]);
        await a.setMonitoringActive(true);
        ctx.assert("A config back after resume", fs.existsSync(ctx.paths.windowConfigFile("win-A")));
      },
    },
    {
      name: "T_CFG1 cleanupSession removes per-window config but not other windows' configs",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        const b = fresh(ctx, "win-B");
        await activate(a);
        await activate(b);
        await a.syncConfig(["rm -rf /"]);
        await b.syncConfig(["mkfs\\\\."]);
        ctx.assert("A config present", fs.existsSync(ctx.paths.windowConfigFile("win-A")));
        ctx.assert("B config present", fs.existsSync(ctx.paths.windowConfigFile("win-B")));
        await a.cleanupSession();
        ctx.assert("A config removed by cleanupSession", !fs.existsSync(ctx.paths.windowConfigFile("win-A")));
        ctx.assert("B config untouched by A cleanup", fs.existsSync(ctx.paths.windowConfigFile("win-B")));
      },
    },
    {
      name: "R3 P2 race: rapid toggle storm + cleanup leaves no ghosts",
      fn: async (ctx) => {
        const a = fresh(ctx, "win-A");
        await activate(a);
        const ops = [];
        for (let i = 0; i < 20; i++) ops.push(a.setEnabled(i % 2 === 0));
        ops.push(a.cleanupSession());
        for (let i = 0; i < 20; i++) ops.push(a.setEnabled(i % 2 === 0));
        await Promise.allSettled(ops);
        ctx.assert(
          "no vote ghost",
          !fs.existsSync(ctx.paths.sessionFile("win-A"))
        );
        ctx.assert(
          "no presence ghost",
          !fs.existsSync(ctx.paths.windowFile("win-A"))
        );
      },
    },
    {
      name: "T_PRUNE pruneOrphanedVotes: removes stale vote+presence, preserves fresh",
      fn: async (ctx) => {
        // Simulate two prior sessions: one stale (crashed > 90s ago) and one
        // fresh (live window refreshed < 60s ago).
        const staleSession = path.join(ctx.paths.sessionsDir, "stale_win");
        const staleWindow = path.join(ctx.paths.windowsDir, "stale_win");
        const freshSession = path.join(ctx.paths.sessionsDir, "fresh_win");
        const freshWindow = path.join(ctx.paths.windowsDir, "fresh_win");

        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.mkdirSync(ctx.paths.windowsDir, { recursive: true });
        fs.writeFileSync(staleSession, "");
        fs.writeFileSync(staleWindow, "");
        fs.writeFileSync(freshSession, "");
        fs.writeFileSync(freshWindow, "");

        // Age the stale pair to 2 minutes ago (> 90 s threshold).
        ctx.helpers.ageOut(staleSession, 2);
        ctx.helpers.ageOut(staleWindow, 2);
        // Leave fresh pair with current mtime (< 60 s old).

        const a = fresh(ctx, "pruner");
        await a.pruneOrphanedVotes();

        ctx.assert("stale session file removed", !fs.existsSync(staleSession));
        ctx.assert("stale window file removed", !fs.existsSync(staleWindow));
        ctx.assert("fresh session file preserved", fs.existsSync(freshSession));
        ctx.assert("fresh window file preserved", fs.existsSync(freshWindow));
      },
    },
    {
      name: "T_PRUNE2 pruneOrphanedVotes: stale observe-only presence (no vote file) is pruned",
      fn: async (ctx) => {
        // An observe-only (paused) window only writes windows/<id> -- never
        // sessions/<id>. If it crashes, the sessions/ scan misses it entirely.
        // The windows/ scan must catch and remove stale presence files, while
        // preserving fresh ones.
        const staleObserveWindow = path.join(ctx.paths.windowsDir, "stale_observe_win");
        const freshObserveWindow = path.join(ctx.paths.windowsDir, "fresh_observe_win");

        fs.mkdirSync(ctx.paths.sessionsDir, { recursive: true });
        fs.mkdirSync(ctx.paths.windowsDir, { recursive: true });
        fs.writeFileSync(staleObserveWindow, "");
        fs.writeFileSync(freshObserveWindow, "");

        // Stale observe-only: presence > 90s old, no vote file
        ctx.helpers.ageOut(staleObserveWindow, 2);
        // Fresh observe-only: presence is recent (< 60 s) -- must be preserved.

        const a = fresh(ctx, "pruner");
        await a.pruneOrphanedVotes();

        ctx.assert(
          "stale observe-only presence removed",
          !fs.existsSync(staleObserveWindow)
        );
        ctx.assert(
          "fresh observe-only presence preserved",
          fs.existsSync(freshObserveWindow)
        );

        // Verify the stale window is no longer counted as live by uninstallGlobal.
        // Set up a single active window B and a prior install, then prune the
        // stale observe-only and check that B gets fullCleanup.
        // Use a fresh test context: remove the fresh_observe_win so only B is alive.
        fs.rmSync(freshObserveWindow);

        const b = fresh(ctx, "win-B");
        b["nodePath"] = process.execPath;
        await b.ensureInstalled();
        await b.setMonitoringActive(true);
        await b.setEnabled(true);
        const r = await b.uninstallGlobal();
        ctx.assert(
          "B is last live window after stale observe-only pruned",
          r.fullCleanup === true,
          `otherLiveWindows=${r.otherLiveWindows}`
        );
      },
    },
  ],
};
