import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface EnsureResult {
  /** Settings.json was created or our hook entry was added/updated */
  settingsChanged: boolean;
  /** Hook script content was written or refreshed */
  scriptChanged: boolean;
  /** Whether the install is now in a working state */
  ok: boolean;
  /** Filled when ok=false, explains what went wrong */
  error?: string;
}

export interface UninstallGlobalResult {
  /** Whether full teardown happened (false = only this window removed) */
  fullCleanup: boolean;
  /** Number of other live VS Code windows still using the hook (counts
   *  presence, not vote -- a paused window still keeps the hook installed). */
  otherLiveWindows: number;
}

export interface UninstallOptions {
  /**
   * True when the user explicitly invoked the "Uninstall Claude Code Hook"
   * command. Sets the stronger `userUninstalled` sticky which is NOT cleared
   * by ensureInstalled() -- only the explicit Reinstall command lifts it.
   * This makes Uninstall durable across status-bar toggles / Start within
   * the same session, as users expect.
   *
   * False (default) for config-driven disables (llmAutoConfirm.enabled
   * flipped to false). Those use only the regular `uninstalled` sticky,
   * which IS cleared by ensureInstalled, so flipping the config back to
   * true reinstalls without forcing the user through the Reinstall command.
   */
  userInitiated?: boolean;
}

/**
 * Manages the Claude Code PreToolUse hook installation lifecycle.
 *
 * Per-window state model: each VS Code window owns one
 * `~/.claude/llm-auto-confirm/sessions/<sessionId>` file. The hook approves
 * iff at least one such file is mtime-fresh (within 10 min). This means:
 * - Pausing / closing a window removes only that window's file; other
 *   windows' auto-confirm state is unaffected.
 * - "Observe Only" / "Stop" are per-window scopes by design.
 * - The Uninstall command is the only path that touches global state
 *   (settings.json entry + hook directory), and even then only when no
 *   other windows are actively using the hook.
 */
export class ClaudeHookInstaller {
  // Uses the VS Code extension-host's os.homedir(), which matches the Claude
  // Code config directory when both run in the same OS environment (native
  // Windows, native Linux/macOS, or VS Code Remote / WSL where the extension
  // host itself runs inside WSL). One known limitation: if the user runs VS
  // Code natively on Windows but launches Claude Code from a WSL terminal, the
  // two processes have different HOME values (~/.claude/ on Windows vs Linux),
  // so the hook is installed into the Windows directory but Claude Code in WSL
  // reads the Linux directory and the hook never fires. In that setup the
  // extension silently falls back to terminal-monitor scraping, which still
  // auto-confirms prompts. A proper fix would require querying Claude Code's
  // actual config directory at install time; no such API exists today.
  private readonly homeDir = os.homedir();
  private readonly claudeDir = path.join(this.homeDir, ".claude");
  private readonly settingsPath = path.join(this.claudeDir, "settings.json");
  private readonly hookDir = path.join(this.claudeDir, "llm-auto-confirm");
  private readonly hookScriptPath = path.join(this.hookDir, "hook.js");
  /** Per-window config file: config-<sessionId>.json. Hook reads ALL
   *  config-*.json files and unions patterns so different workspace blacklists
   *  compose rather than overwrite each other. Initialized in constructor
   *  (needs sessionId which is a ctor param, set after field initializers). */
  private readonly configPath: string;
  /** Per-window vote files. Hook unions across these to decide approve. */
  private readonly sessionsDir = path.join(this.hookDir, "sessions");
  private readonly sessionFilePath: string;
  /** Per-window presence files. uninstallGlobal() looks here -- a window that
   *  is alive but paused (no vote) still keeps the hook installed for itself
   *  and others. Decoupling presence from vote prevents an Uninstall in one
   *  window from removing the global hook while another window is merely
   *  paused (which would leave that window's later resume non-functional). */
  private readonly windowsDir = path.join(this.hookDir, "windows");
  private readonly windowFilePath: string;
  /** On-disk marker dropped when a user-initiated Uninstall hits the
   *  partial-cleanup branch (other windows still alive). The marker tells
   *  the LAST window to close (any window's cleanupSession) to finish the
   *  global uninstall on the user's behalf, instead of just removing its
   *  own session/presence. Without it, "close the other windows to fully
   *  remove" never actually converges. */
  private readonly pendingUninstallMarker: string;
  /** How often to refresh both presence and (if voting) the vote file. Hook
   *  treats >10 min stale as inactive, so refresh comfortably below that. */
  private static readonly HEARTBEAT_INTERVAL_MS = 60 * 1000;
  /** Mtime-freshness window matching the hook script's SESSION_MAX_AGE_MS. */
  private static readonly SESSION_MAX_AGE_MS = 10 * 60 * 1000;
  /** Single timer that refreshes presence (always while installed) and the
   *  vote file (only if it currently exists). */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Promise of the heartbeat tick currently in flight, if any. Cleanup paths
   *  await this so a tick that already issued a writeFile syscall completes
   *  (and gets superseded by the cleanup's unlink) before we return -- no
   *  ghost files left on disk after deactivate. */
  private currentTick: Promise<void> | null = null;
  /** Transient sticky: set by cleanupSession() and uninstallGlobal(). Prevents
   *  setEnabled / setMonitoringActive / syncConfig / tickHeartbeat from
   *  recreating files. Cleared by ensureInstalled() so a config flip
   *  enabled=false -> true, or partial uninstall + later re-enable, can
   *  bring everything back without forcing the user through Reinstall. */
  private uninstalled = false;
  /** Stronger sticky: set ONLY by uninstallGlobal({ userInitiated: true }),
   *  i.e. the user clicked the Uninstall Claude Code Hook command. NOT
   *  cleared by ensureInstalled(); only the explicit reinstall() method
   *  (wired to the Reinstall command) lifts it. While set, ensureInstalled
   *  is itself a no-op so subsequent toggles / Start / config flips do NOT
   *  silently undo the user's explicit Uninstall. */
  private userUninstalled = false;
  /** Resolved absolute path to a verified `node` executable, captured at
   *  install time. Used in the hook command we register in settings.json.
   *  Resolving up-front + writing an absolute path means the hook still
   *  runs even when Claude Code is launched from a shell environment that
   *  doesn't expose `node` on PATH. */
  private nodePath: string | null = null;
  /** Monotonic counter bumped by every uninstall path (uninstallGlobal /
   *  cleanupSession). ensureInstalled() captures it at entry and re-checks
   *  after every await; if the value changed it means a concurrent uninstall
   *  fired and ensureInstalled aborts without writing files (and without
   *  resetting `uninstalled` to false). Without this, an in-flight install
   *  could undo a successful concurrent uninstall by recreating files +
   *  flipping the sticky back to false. */
  private uninstallGen = 0;
  /** Transient gate flipped synchronously by setMonitoringActive(false) so
   *  any heartbeat tick that's already queued / mid-flight bails at its next
   *  yield instead of writing a fresh presence file after the cleanup ran.
   *  Distinct from `uninstalled`: setMonitoringActive(true) flips it back on
   *  without going through ensureInstalled. */
  private monitoringActive = false;

  constructor(
    private readonly extensionPath: string,
    /** Stable, unique-per-window identifier. Pass a per-activation UUID
     *  (e.g. `randomUUID()` called in `activate()`), NOT `vscode.env.sessionId`
     *  which is shared by all windows in the same application session. */
    private readonly sessionId: string,
    private readonly log: (msg: string) => void
  ) {
    // Sanitize sessionId to a fs-safe filename.
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
    this.sessionFilePath = path.join(this.sessionsDir, safe);
    this.windowFilePath = path.join(this.windowsDir, safe);
    this.configPath = path.join(this.hookDir, `config-${safe}.json`);
    this.pendingUninstallMarker = path.join(this.hookDir, ".pending-uninstall");
  }

  /** Public-facing description of what we modify, for status messages. */
  describePaths(): { settings: string; hookDir: string; sessionFile: string } {
    return {
      settings: this.settingsPath,
      hookDir: this.hookDir,
      sessionFile: this.sessionFilePath,
    };
  }

  isInstalled(): boolean {
    return fsSync.existsSync(this.hookScriptPath);
  }

  /** Whether THIS window's session file currently exists. */
  isEnabled(): boolean {
    return fsSync.existsSync(this.sessionFilePath);
  }

  /**
   * Idempotently install/update the hook script and settings.json entry.
   * Safe to call on every activation.
   */
  async ensureInstalled(): Promise<EnsureResult> {
    if (this.userUninstalled) {
      // Honor the user's explicit Uninstall command. Coming back via
      // toggle / Start / config flip must NOT silently recreate files;
      // only the explicit Reinstall command (which calls reinstall()
      // below) lifts this gate.
      return { settingsChanged: false, scriptChanged: false, ok: true };
    }
    // Capture uninstall generation at entry. If anything (uninstallGlobal,
    // cleanupSession) bumps it during our awaits, that means a concurrent
    // uninstall fired -- abort without writing files and without flipping
    // `uninstalled` back to false. See `aborted()` checks below.
    const gen = this.uninstallGen;
    const aborted = () =>
      this.userUninstalled || this.uninstallGen !== gen;
    const NOOP: EnsureResult = {
      settingsChanged: false,
      scriptChanged: false,
      ok: true,
    };

    try {
      // Read source script first -- used by both the fast path (content
      // comparison) and the full install path (writing/refreshing hook.js).
      const sourceScript = path.join(
        this.extensionPath,
        "resources",
        "claude-hook.js"
      );
      const scriptContent = await fs.readFile(sourceScript, "utf8");
      if (aborted()) return NOOP;

      // Fast path: if hook.js content and the settings entry are both already
      // current, skip resolveNodePath() entirely.
      //
      // resolveNodePath() shells out to `where node` / `which node`, which
      // fails in GUI-launched VS Code sessions (macOS app launch, Windows
      // Start Menu) that do not inherit a shell PATH. When the hook is already
      // installed the node path embedded in settings.json is still valid; we
      // simply do not need to re-discover it to refresh presence/vote files.
      if (await this.isFullyInstalled(scriptContent)) {
        if (aborted()) return NOOP;
        // Best-effort migration cleanup (pre-0.7.x artifacts). removeIfExists
        // swallows ENOENT, so this is a no-op when the files don't exist.
        await this.removeIfExists(path.join(this.hookDir, "enabled"));
        await this.removeIfExists(path.join(this.hookDir, "heartbeat"));
        await this.removeIfExists(path.join(this.hookDir, "config.json"));
        if (aborted()) return NOOP;
        this.uninstalled = false;
        return NOOP;
      }

      // Full install path: need a usable node interpreter to (re)write hook.js,
      // platform shims, and the settings.json entry. If we can't find one,
      // refuse install and fall back to the terminal monitor rather than
      // silently ship a broken hook command.
      //
      // Clear any stale cached nodePath first: isFullyInstalled() returning
      // false may mean the stored binary no longer exists (nvm/Volta switch).
      // Without this clear, resolveNodePath() would short-circuit on
      // `if (this.nodePath)` and return the dead path, writing a broken hook.
      this.nodePath = null;
      const nodePath = await this.resolveNodePath();
      if (aborted()) return NOOP;
      if (!nodePath) {
        return {
          settingsChanged: false,
          scriptChanged: false,
          ok: false,
          error:
            "Could not find a 'node' executable on PATH. Install Node.js (https://nodejs.org/) and reload VS Code, then run 'Reinstall Claude Code Hook'.",
        };
      }
      this.nodePath = nodePath;

      // Defer clearing `uninstalled` until ALL writes succeed and no
      // concurrent uninstall has fired. Setting it false eagerly here would
      // leave it cleared if we then bail mid-flight, masking the concurrent
      // uninstall's intent.
      await fs.mkdir(this.hookDir, { recursive: true });
      if (aborted()) return NOOP;
      await fs.mkdir(this.sessionsDir, { recursive: true });
      if (aborted()) return NOOP;
      await fs.mkdir(this.windowsDir, { recursive: true });
      if (aborted()) return NOOP;

      // scriptContent already read above.
      let scriptChanged = false;
      try {
        const existing = await fs.readFile(this.hookScriptPath, "utf8");
        if (aborted()) return NOOP;
        if (existing !== scriptContent) {
          await fs.writeFile(this.hookScriptPath, scriptContent);
          if (aborted()) return NOOP;
          scriptChanged = true;
        }
      } catch (err: any) {
        if (err && err.code === "ENOENT") {
          await fs.writeFile(this.hookScriptPath, scriptContent);
          if (aborted()) return NOOP;
          scriptChanged = true;
        } else {
          throw err;
        }
      }

      // Best-effort migration: remove pre-0.7.x global sentinel/heartbeat
      // files. The new hook script doesn't read them, but they would be
      // confusing leftovers.
      await this.removeIfExists(path.join(this.hookDir, "enabled"));
      if (aborted()) return NOOP;
      await this.removeIfExists(path.join(this.hookDir, "heartbeat"));
      if (aborted()) return NOOP;
      // Migration: remove old shared config.json (pre-per-window-config era).
      // The hook now reads config-<sessionId>.json files so each workspace
      // maintains its own blacklist; the old single file is dead weight and
      // could be confused for a live config by debugging tools.
      await this.removeIfExists(path.join(this.hookDir, "config.json"));
      if (aborted()) return NOOP;

      // Windows: when node is in a path with spaces, write a .cmd shim so
      // settings.json can reference it unquoted (works in both PowerShell and
      // cmd.exe). No-op on POSIX or when node path has no spaces.
      await this.writeShimIfNeeded();
      if (aborted()) return NOOP;

      const settingsChanged = await this.ensureSettingsEntry();
      if (aborted()) return NOOP;

      // All writes succeeded with no concurrent uninstall. NOW it's safe
      // to clear the sticky -- subsequent setMonitoringActive/setEnabled
      // calls will succeed.
      this.uninstalled = false;

      // ensureInstalled only puts the global artifacts in place: hook.js,
      // settings.json entry, dirs. It does NOT write presence or start the
      // heartbeat -- those are managed by setMonitoringActive(true), which
      // the caller invokes only when the window is actually opting into
      // auto-confirm. This keeps llmAutoConfirm.enabled=false windows
      // genuinely inert (no presence file means they don't count toward
      // another window's uninstall decision).

      return { settingsChanged, scriptChanged, ok: true };
    } catch (err: any) {
      const msg = err && err.message ? err.message : String(err);
      this.log(`Hook install error: ${msg}`);
      return {
        settingsChanged: false,
        scriptChanged: false,
        ok: false,
        error: msg,
      };
    }
  }

  /**
   * Toggle this window's monitoring active state. Writes/refreshes the
   * presence file and starts the heartbeat when active; removes BOTH
   * presence and vote and stops the heartbeat when inactive.
   *
   * The presence file is what makes another window's Uninstall command
   * report "partial cleanup, N other windows alive". Setting active=false
   * means this window stops counting -- which is correct when the user has
   * stopped monitoring or set llmAutoConfirm.enabled to false. (Pausing
   * to Observe Only is a different operation: that's setEnabled(false),
   * which only drops the vote and keeps the window present/alive.)
   */
  async setMonitoringActive(active: boolean): Promise<void> {
    if (this.uninstalled || this.userUninstalled) return;
    try {
      if (active) {
        // Flip the gate ON synchronously before any await so the heartbeat
        // tick (started right below) sees the right state on its first run.
        this.monitoringActive = true;
        await fs.mkdir(this.windowsDir, { recursive: true });
        if (this.uninstalled || this.userUninstalled || !this.monitoringActive) return;
        await fs.writeFile(this.windowFilePath, String(Date.now()));
        this.startHeartbeatInternal();
      } else {
        // Flip the gate OFF synchronously BEFORE any await. This matters
        // even though we clearInterval below: a timer callback that already
        // expired and is sitting in the macrotask queue isn't cancelled by
        // clearInterval, so it WILL run -- when it does, tickHeartbeat must
        // see monitoringActive=false at its first synchronous gate check
        // and bail without ever writing files.
        this.monitoringActive = false;
        this.stopHeartbeatInternal();
        if (this.currentTick) {
          try { await this.currentTick; } catch { /* tick errors are not fatal here */ }
        }
        // Remove vote first then presence: ordering matches the hook's read
        // order, so a hook called mid-removal can never read presence-fresh-
        // but-vote-stale and approve incorrectly.
        await this.removeIfExists(this.sessionFilePath);
        await this.removeIfExists(this.windowFilePath);
        // Remove per-window config so a stopped window's dangerousCommandPatterns
        // no longer bleed into active windows via the hook's union read. The
        // config is re-written by syncConfig when monitoring resumes (all callers
        // of setMonitoringActive(true) first call syncConfig).
        await this.removeIfExists(this.configPath);
      }
    } catch (err: any) {
      this.log(`Monitoring ${active ? "activate" : "deactivate"} error: ${err}`);
    }
  }

  /**
   * Per-window vote: present file = this window wants auto-approve. Absent
   * file = this window is observing/stopped. The hook unions across all
   * windows' vote files, so this only affects THIS window's vote.
   *
   * Presence (windows/<id>) is managed by setMonitoringActive, NOT here.
   * Pausing via setEnabled(false) is a per-window opt-out of voting that
   * keeps the window alive (presence stays). This is the right semantic for
   * "Observe Only" -- a paused window is still using the global hook for
   * itself and others.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.uninstalled || this.userUninstalled) return;
    try {
      if (enabled) {
        await fs.mkdir(this.sessionsDir, { recursive: true });
        // Re-check after each await: a concurrent cleanupSession() /
        // uninstallGlobal() may have flipped the gate while we were yielded.
        // Without this, we'd recreate a vote file the cleanup just deleted.
        if (this.uninstalled || this.userUninstalled) return;
        await fs.writeFile(this.sessionFilePath, String(Date.now()));
      } else {
        await this.removeIfExists(this.sessionFilePath);
      }
    } catch (err: any) {
      this.log(`Session ${enabled ? "create" : "remove"} error: ${err}`);
    }
  }

  /** Push the current dangerous-command blacklist out for the hook to use. */
  async syncConfig(dangerousPatterns: string[]): Promise<void> {
    if (this.uninstalled || this.userUninstalled) return;
    try {
      await fs.mkdir(this.hookDir, { recursive: true });
      // Re-check after the mkdir await: a racing cleanup may have flipped the
      // gate. Skipping the writeFile keeps us from recreating config inside
      // a directory the cleanup is about to (or just did) `fs.rm`.
      if (this.uninstalled || this.userUninstalled) return;
      await fs.writeFile(
        this.configPath,
        JSON.stringify(
          { dangerousCommandPatterns: dangerousPatterns },
          null,
          2
        )
      );
    } catch (err: any) {
      this.log(`Config sync error: ${err}`);
    }
  }

  /**
   * Remove session/vote files that haven't been refreshed by a live heartbeat.
   * The heartbeat runs every 60 s; files untouched for more than 1.5x that
   * (90 s) belong to a window whose heartbeat stopped -- either crashed or
   * cleanly deactivated but whose cleanup was skipped. Removing them prevents
   * a crashed session's fresh-looking vote file from auto-approving for up to
   * SESSION_MAX_AGE_MS (10 min) after the crash.
   *
   * Safe for live windows: they refresh every 60 s so their files are always
   * younger than the 90 s threshold. The corresponding presence file is
   * co-removed so uninstallGlobal()'s live-window count stays accurate.
   *
   * Also scans windows/ for stale presence files left by crashed observe-only
   * windows. Observe-only windows (Observe Only mode / paused) never write a
   * vote file, so the sessions/ scan above would miss them entirely. A stale
   * presence file from such a crash keeps uninstallGlobal() returning partial
   * cleanup even though no actual window is alive.
   */
  async pruneOrphanedVotes(): Promise<void> {
    const staleMs = ClaudeHookInstaller.HEARTBEAT_INTERVAL_MS * 1.5;
    const now = Date.now();

    // Prune stale vote files and their paired presence files.
    try {
      const names = await fs.readdir(this.sessionsDir);
      for (const name of names) {
        const sessionFile = path.join(this.sessionsDir, name);
        let stat: import("fs").Stats;
        try {
          stat = fsSync.statSync(sessionFile);
        } catch {
          continue; // already gone
        }
        if (now - stat.mtimeMs > staleMs) {
          await this.removeIfExists(sessionFile);
          await this.removeIfExists(path.join(this.windowsDir, name));
        }
      }
    } catch {
      // sessions/ missing or readdir error -- nothing to prune
    }

    // Prune stale presence files for crashed observe-only windows. Those
    // windows only write windows/<id>, never sessions/<id>, so the scan
    // above misses them. removeIfExists swallows ENOENT, so removing an
    // already-gone pair from the first loop is harmless.
    try {
      const names = await fs.readdir(this.windowsDir);
      for (const name of names) {
        const windowFile = path.join(this.windowsDir, name);
        let stat: import("fs").Stats;
        try {
          stat = fsSync.statSync(windowFile);
        } catch {
          continue;
        }
        if (now - stat.mtimeMs > staleMs) {
          await this.removeIfExists(path.join(this.sessionsDir, name));
          await this.removeIfExists(windowFile);
        }
      }
    } catch {
      // windows/ missing or readdir error -- nothing to prune
    }
  }

  async cleanupSession(): Promise<void> {
    // Sticky FIRST so any in-flight tick / setEnabled / syncConfig sees the
    // gate at its next yield and bails. Bump the uninstall generation so
    // any in-flight ensureInstalled() also detects this and aborts.
    this.uninstalled = true;
    this.monitoringActive = false;
    this.uninstallGen++;
    this.stopHeartbeatInternal();
    if (this.currentTick) {
      try { await this.currentTick; } catch { /* tick errors are not fatal here */ }
    }
    await this.removeIfExists(this.sessionFilePath);
    await this.removeIfExists(this.windowFilePath);
    await this.removeIfExists(this.configPath);

    // If a previous user-initiated Uninstall did partial cleanup
    // (because we / others were still alive), and we're now the last
    // window to leave, finish the global uninstall on the user's behalf.
    // This is what makes "close the other windows to fully remove"
    // actually converge.
    try {
      if (fsSync.existsSync(this.pendingUninstallMarker)) {
        const otherLive = this.countLiveWindowsExcludingSelf();
        if (otherLive === 0) {
          await this.finishGlobalCleanup();
        }
      }
    } catch (err: any) {
      this.log(`Pending-uninstall finish error: ${err}`);
    }
  }

  /**
   * Explicit user-triggered teardown (the "Uninstall Claude Code Hook"
   * command). Always removes this window's vote and presence files. Removes
   * settings.json entry + hook directory ONLY when no other VS Code windows
   * are alive -- using PRESENCE (windows/) not vote (sessions/), so a window
   * that is paused / Observe Only still keeps the global hook installed.
   * Otherwise reports a partial uninstall so the caller can inform the user.
   *
   * Sticky: this installer instance enters uninstalled state regardless of
   * whether the cleanup was full or partial -- the user explicitly asked to
   * stop using the hook from this window, so we must not silently recreate
   * any artifacts here.
   */
  async uninstallGlobal(
    opts: UninstallOptions = {}
  ): Promise<UninstallGlobalResult> {
    // Race-safety gate: set BEFORE any await so in-flight tick / setEnabled /
    // syncConfig calls bail at their next yield point and don't recreate
    // files inside a directory we're about to `fs.rm`. See cleanupSession.
    this.uninstalled = true;
    if (opts.userInitiated) {
      // Stronger sticky: ensureInstalled won't undo this. Only the
      // explicit Reinstall command (via reinstall()) lifts it.
      this.userUninstalled = true;
    }
    this.monitoringActive = false;
    // Bump uninstall generation so any in-flight ensureInstalled() detects
    // this concurrent uninstall and aborts without writing files. Without
    // this, an install that started before us could finish writing to disk
    // AFTER we returned, silently undoing the uninstall the caller saw
    // succeed.
    this.uninstallGen++;
    this.stopHeartbeatInternal();
    if (this.currentTick) {
      try { await this.currentTick; } catch { /* tick errors are not fatal here */ }
    }
    await this.removeIfExists(this.sessionFilePath);
    await this.removeIfExists(this.windowFilePath);
    await this.removeIfExists(this.configPath);

    const otherLive = this.countLiveWindowsExcludingSelf();
    if (otherLive > 0) {
      if (opts.userInitiated) {
        // Persist the user's intent so when the last other window's
        // cleanupSession runs, it can finish what they asked for. Without
        // this, "close the other windows to fully remove" would never
        // actually converge.
        try {
          await fs.writeFile(
            this.pendingUninstallMarker,
            String(Date.now())
          );
        } catch (err: any) {
          this.log(`Pending-uninstall marker write failed: ${err}`);
        }
      }
      return { fullCleanup: false, otherLiveWindows: otherLive };
    }

    await this.finishGlobalCleanup();
    return { fullCleanup: true, otherLiveWindows: 0 };
  }

  /** Remove settings.json hook entry + the entire hook directory. Called
   *  from uninstallGlobal's full-cleanup branch AND from cleanupSession when
   *  this window is the last one to leave with a pending-uninstall marker.
   *
   *  If removeSettingsEntry() throws (e.g. settings.json is malformed),
   *  the exception propagates and fs.rm is intentionally skipped. Leaving
   *  hookDir intact prevents a dangling PreToolUse entry pointing at a missing
   *  script; callers already have try/catch and surface the error to the user. */
  private async finishGlobalCleanup(): Promise<void> {
    await this.removeSettingsEntry(); // throws on malformed settings.json
    try {
      await fs.rm(this.hookDir, { recursive: true, force: true });
    } catch (err: any) {
      this.log(`finishGlobalCleanup: failed to remove ${this.hookDir}: ${err}`);
    }
  }

  /**
   * Lift the user-initiated uninstall sticky and run a fresh ensureInstalled.
   * Wired to the explicit "Reinstall Claude Code Hook" command -- this is the
   * ONLY path that recovers from a user-initiated uninstall.
   */
  async reinstall(): Promise<EnsureResult> {
    this.userUninstalled = false;
    // Clear any pending-uninstall marker -- the user is explicitly asking
    // for the hook to be back, so the prior Uninstall request from this or
    // any other window is overridden.
    await this.removeIfExists(this.pendingUninstallMarker);
    return this.ensureInstalled();
  }

  // --- Private helpers -----------------------------------------------------

  /**
   * Returns true when both artifacts that make up a complete install are
   * already current: hook.js content matches the extension's source,
   * settings.json contains our PreToolUse entry, AND the node binary
   * referenced in that entry still exists on disk.
   *
   * The node-binary check prevents the fast path from being taken after an
   * nvm/Volta version switch or a Node removal -- in those cases the stored
   * absolute path no longer works and the full install path must re-discover
   * the current interpreter via resolveNodePath(). When the check passes,
   * the validated path is cached in this.nodePath so subsequent callers
   * (ensureInstalled, syncClaudeHookState) do not need a PATH lookup.
   */
  private async isFullyInstalled(scriptContent: string): Promise<boolean> {
    try {
      const installed = await fs.readFile(this.hookScriptPath, "utf8");
      if (installed !== scriptContent) return false;
    } catch {
      return false;
    }
    let command: string | undefined;
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      const settings = JSON.parse(raw);
      const entry = settings?.hooks?.PreToolUse?.find((e: any) =>
        this.isOurEntry(e)
      );
      const hook = entry?.hooks?.find(
        (h: any) => typeof h.command === "string"
      );
      command = hook?.command;
    } catch {
      return false;
    }
    if (!command) return false;
    const nodePath = this.extractNodePath(command);
    if (!nodePath || !fsSync.existsSync(nodePath)) return false;
    this.nodePath = nodePath;
    return true;
  }

  /**
   * Extracts the node interpreter path from a hook command string as stored
   * in settings.json. Returns null when the format is unrecognised or the
   * shim file cannot be read. Used by isFullyInstalled() to validate that
   * the stored binary still exists before taking the fast path.
   *
   * Three command shapes are possible (see buildHookCommand):
   *   POSIX / Windows Case 1: ["node" | node] "script_path"
   *   Windows Case 2 (.cmd shim): hookDir\claude-hook-runner.cmd
   *   Windows Case 3 (.ps1 shim): powershell -File "hookDir\claude-hook-runner.ps1"
   */
  private extractNodePath(command: string): string | null {
    // Case 2: .cmd shim -- node is on the first line: @"node_path" "script"
    if (command.endsWith(".cmd")) {
      try {
        const shim = fsSync.readFileSync(command, "utf8");
        const m = shim.match(/^@"([^"]+)"/);
        return m ? m[1] : null;
      } catch { return null; }
    }
    // Case 3: .ps1 shim -- invoked via `powershell -File "path.ps1"`
    if (command.startsWith("powershell")) {
      const ps1m = command.match(/-File "([^"]+)"/);
      if (!ps1m) return null;
      try {
        const shim = fsSync.readFileSync(ps1m[1], "utf8");
        // shim content: & 'node_path' 'script_path'\n
        const m = shim.match(/^& '([^']+)'/);
        return m ? m[1] : null;
      } catch { return null; }
    }
    // POSIX: "node_path" "script_path"
    if (command.startsWith('"')) {
      const m = command.match(/^"([^"]+)"/);
      return m ? m[1] : null;
    }
    // Windows Case 1: node_path "script_path" (no spaces in node path)
    const spaceIdx = command.indexOf(" ");
    return spaceIdx >= 0 ? command.substring(0, spaceIdx) : null;
  }

  /**
   * Find an absolute path to a working `node` interpreter at install time.
   * Uses PATH lookup (`where`/`which`) and verifies the resolved binary
   * executes (`--version` returns a vN.M.P string) before trusting it.
   *
   * Returns null if no usable node is found; callers refuse install in that
   * case rather than ship a settings.json entry that can't run.
   *
   * Note: process.execPath in VS Code's extension host points at the
   * Electron binary (Code.exe), not a standalone Node.js binary, so it
   * cannot be used as a fallback here.
   */
  private async resolveNodePath(): Promise<string | null> {
    if (this.nodePath) return this.nodePath;
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(finder, ["node"]);
      const first = stdout
        .split(/\r?\n/)
        .map((s: string) => s.trim())
        .find(Boolean);
      if (!first || !fsSync.existsSync(first)) return null;
      const { stdout: ver } = await execFileAsync(first, ["--version"]);
      if (!/^v\d+\./.test(ver.trim())) return null;
      return first;
    } catch {
      return null;
    }
  }


  private startHeartbeatInternal(): void {
    if (this.uninstalled) return;
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const p = this.tickHeartbeat();
      this.currentTick = p;
      void p.finally(() => {
        if (this.currentTick === p) this.currentTick = null;
      });
    }, ClaudeHookInstaller.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatInternal(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Single heartbeat tick: always refresh presence (so this window keeps
   * counting as alive), and refresh the vote file ONLY if it currently
   * exists (so we don't accidentally re-vote when the user has paused).
   *
   * Race-safety: re-check `this.uninstalled` AND `this.monitoringActive`
   * after every await. Either flag flipping while we're yielded means the
   * cleanup path (uninstallGlobal / cleanupSession / setMonitoringActive
   * (false)) is in progress; a pending writeFile would otherwise resurrect
   * a file the cleanup just deleted, leaving a 10-minute-live ghost.
   */
  private async tickHeartbeat(): Promise<void> {
    if (this.uninstalled || this.userUninstalled || !this.monitoringActive) return;
    try {
      await fs.mkdir(this.windowsDir, { recursive: true });
      if (this.uninstalled || this.userUninstalled || !this.monitoringActive) return;
      await fs.writeFile(this.windowFilePath, String(Date.now()));
      if (this.uninstalled || this.userUninstalled || !this.monitoringActive) return;
      if (fsSync.existsSync(this.sessionFilePath)) {
        if (this.uninstalled || this.userUninstalled || !this.monitoringActive) return;
        await fs.writeFile(this.sessionFilePath, String(Date.now()));
      }
    } catch (err: any) {
      this.log(`Heartbeat write failed: ${err}`);
    }
  }

  /**
   * Counts other VS Code windows still using the hook by their PRESENCE,
   * not their vote. A window that is alive but paused (no vote file) still
   * counts -- removing the global hook out from under it would break its
   * later resume. Stale (>10 min) presence files are ignored.
   */
  private countLiveWindowsExcludingSelf(): number {
    let entries: string[];
    try {
      entries = fsSync.readdirSync(this.windowsDir);
    } catch {
      return 0;
    }
    const now = Date.now();
    let count = 0;
    for (const name of entries) {
      const full = path.join(this.windowsDir, name);
      if (full === this.windowFilePath) continue;
      let stat;
      try {
        stat = fsSync.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs <= ClaudeHookInstaller.SESSION_MAX_AGE_MS) {
        count++;
      }
    }
    return count;
  }

  private async removeIfExists(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err && err.code !== "ENOENT") {
        this.log(`Remove ${filePath} failed: ${err}`);
      }
    }
  }

  /**
   * Returns true if settings.json was created/changed.
   * Identifies our entry by command-string match against the hook script path,
   * so we don't pollute settings.json with extension-private fields.
   */
  private async ensureSettingsEntry(): Promise<boolean> {
    let settings: any = {};
    let existed = false;
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      settings = JSON.parse(raw);
      existed = true;
      if (settings === null || typeof settings !== "object") {
        settings = {};
      }
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        // Will create.
      } else if (err instanceof SyntaxError) {
        this.log(
          `settings.json is not valid JSON; refusing to overwrite: ${err.message}`
        );
        throw new Error(
          "~/.claude/settings.json is not valid JSON. Fix it and reload."
        );
      } else {
        throw err;
      }
    }

    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    if (!Array.isArray(settings.hooks.PreToolUse)) {
      settings.hooks.PreToolUse = [];
    }

    const desired = this.buildHookEntry();

    let changed = false;
    const existingIdx = settings.hooks.PreToolUse.findIndex((e: any) =>
      this.isOurEntry(e)
    );

    if (existingIdx >= 0) {
      const existing = settings.hooks.PreToolUse[existingIdx];
      if (JSON.stringify(existing) !== JSON.stringify(desired)) {
        settings.hooks.PreToolUse[existingIdx] = desired;
        changed = true;
      }
    } else {
      settings.hooks.PreToolUse.push(desired);
      changed = true;
    }

    if (changed || !existed) {
      await fs.mkdir(this.claudeDir, { recursive: true });
      await fs.writeFile(
        this.settingsPath,
        JSON.stringify(settings, null, 2) + "\n"
      );
      return true;
    }
    return false;
  }

  private async removeSettingsEntry(): Promise<void> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      const settings = JSON.parse(raw);
      if (
        settings &&
        settings.hooks &&
        Array.isArray(settings.hooks.PreToolUse)
      ) {
        const before = settings.hooks.PreToolUse.length;
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
          (e: any) => !this.isOurEntry(e)
        );
        if (settings.hooks.PreToolUse.length === 0) {
          delete settings.hooks.PreToolUse;
        }
        if (
          settings.hooks &&
          Object.keys(settings.hooks).length === 0
        ) {
          delete settings.hooks;
        }
        if (settings.hooks?.PreToolUse?.length !== before) {
          await fs.writeFile(
            this.settingsPath,
            JSON.stringify(settings, null, 2) + "\n"
          );
        }
      }
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        return; // no settings.json = no entry to remove, nothing to do
      }
      // settings.json exists but is malformed (SyntaxError) or write failed.
      // Re-throw so finishGlobalCleanup() does NOT delete the hook directory:
      // leaving hookDir intact means the dangling PreToolUse entry in
      // settings.json still points at an existing hook.js, which is safer than
      // a dangling pointer to a missing script. Mirrors the throw in
      // ensureSettingsEntry() for the same malformed-JSON scenario.
      this.log(`Settings cleanup error: ${err}`);
      throw err;
    }
  }

  private buildHookEntry() {
    return {
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command: this.buildHookCommand(),
        },
      ],
    };
  }

  /**
   * Writes a platform shim when the node interpreter path contains spaces.
   * Windows has no single invocation syntax that works in both PowerShell
   * and cmd.exe for a quoted executable:
   *   "C:\path\node.exe" args  -- PowerShell: string expression, not a command
   *   & "C:\path\node.exe" args -- cmd.exe: "& was unexpected at this time"
   *
   * Two strategies depending on whether hookDir is space-free:
   *   Case 2 (hookDir no spaces): .cmd shim, referenced unquoted in settings.
   *     Both shells can invoke an unquoted .cmd path. The shim uses cmd-native
   *     double-quoted syntax internally.
   *   Case 3 (hookDir has spaces, e.g. username "John Doe"): .ps1 shim, invoked
   *     via `powershell -NoProfile -NonInteractive -File "shim.ps1"`.
   *     PowerShell accepts `"..."` as the -File value (string literal), and
   *     cmd.exe passes the double-quoted argument to powershell.exe verbatim.
   *     The .ps1 uses & 'single-quoted' invocation which handles spaces.
   *     stdin is inherited by node through both the outer shell and PowerShell.
   */
  private async writeShimIfNeeded(): Promise<void> {
    const node = this.nodePath || "node";
    if (process.platform !== "win32" || !node.includes(" ")) return;
    if (!this.hookDir.includes(" ")) {
      // Case 2: .cmd shim -- no spaces in shim path, unquoted invocation works
      // @ on the line suppresses cmd.exe echo to stdout (would corrupt JSON)
      const nodeQ = node.replace(/"/g, '""');
      const scriptQ = this.hookScriptPath.replace(/"/g, '""');
      await fs.writeFile(
        path.join(this.hookDir, "claude-hook-runner.cmd"),
        `@"${nodeQ}" "${scriptQ}"\r\n`,
        "utf8"
      );
    } else {
      // Case 3: .ps1 shim -- invoked via `powershell -File "shim.ps1"`.
      // Single-quoted paths handle spaces in both node and script paths.
      const nodeQ = node.replace(/'/g, "''");
      const scriptQ = this.hookScriptPath.replace(/'/g, "''");
      await fs.writeFile(
        path.join(this.hookDir, "claude-hook-runner.ps1"),
        `& '${nodeQ}' '${scriptQ}'\n`,
        "utf8"
      );
    }
  }

  private buildHookCommand(): string {
    const node = this.nodePath || "node";
    const scriptQ = `"${this.hookScriptPath.replace(/"/g, '\\"')}"`;
    if (process.platform === "win32") {
      if (!node.includes(" ")) {
        // Case 1: no spaces -- unquoted absolute path is a valid command in
        // both PowerShell and cmd.exe; quoted script arg handles any spaces.
        return `${node} ${scriptQ}`;
      }
      if (!this.hookDir.includes(" ")) {
        // Case 2: node has spaces, hookDir does not -- unquoted .cmd shim path
        return path.join(this.hookDir, "claude-hook-runner.cmd");
      }
      // Case 3: both have spaces -- powershell -File "shim.ps1".
      // -File with a double-quoted path works in both PowerShell (string arg)
      // and cmd.exe (double-quoted argument forwarded to powershell.exe).
      const ps1 = path.join(this.hookDir, "claude-hook-runner.ps1");
      return `powershell -NoProfile -NonInteractive -File "${ps1.replace(/"/g, '\\"')}"`;
    }
    return `"${node.replace(/"/g, '\\"')}" ${scriptQ}`;
  }

  private isOurEntry(entry: any): boolean {
    if (!entry || !Array.isArray(entry.hooks)) return false;
    // Recognize all three command shapes we generate, using hookDir-derived
    // paths directly (not nodePath-dependent) so this works even when
    // nodePath is null (e.g. removeSettingsEntry during uninstallGlobal).
    const shimCmd = path.join(this.hookDir, "claude-hook-runner.cmd");
    const shimPs1 = path.join(this.hookDir, "claude-hook-runner.ps1");
    return entry.hooks.some(
      (h: any) =>
        h &&
        typeof h.command === "string" &&
        // Direct invocation (Case 1 / POSIX): command includes the script path.
        // Substring match on "llm-auto-confirm" alone would risk matching
        // unrelated user hooks, so we use the full hookScriptPath.
        (h.command.includes(this.hookScriptPath) ||
         h.command === shimCmd ||        // Case 2: exact .cmd shim path
         h.command.includes(shimPs1))    // Case 3: powershell -File "shim.ps1"
    );
  }
}
