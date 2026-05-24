import * as vscode from "vscode";
import { randomUUID } from "crypto";
import {
  TerminalMonitor,
  TerminalMonitorConfig,
  PromptRule,
} from "./terminal-monitor";
import {
  WebviewMonitor,
  WebviewMonitorConfig,
  ApprovalCommandEntry,
} from "./webview-monitor";
import { ClaudeHookInstaller } from "./claude-hook-installer";

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let isMonitoring = false;
let isAutoConfirmEnabled = false;
/** Last-seen value of `llmAutoConfirm.enabled` (merged workspace+user). */
let prevConfigEnabled = false;
/** Last-seen value of `isEnabledAtUserLevel()`. Tracked separately so that
 *  user-level changes are detected even when a workspace override keeps the
 *  merged config.enabled constant (e.g. workspace=true masks user false->true).
 *  Without this, toggling the user-level setting while a workspace override is
 *  active would be silently ignored by onDidChangeConfiguration. */
let prevUserLevelEnabled = true;
let isWebviewEnabled = false;
let claudeHookInstaller: ClaudeHookInstaller | null = null;

/**
 * Push our current runtime state to the Claude hook installer:
 *   isMonitoring=true  -> presence file alive, heartbeat running
 *   isMonitoring=false -> presence file removed, heartbeat stopped
 *   isMonitoring=true && isAutoConfirmEnabled=true -> vote file alive
 *
 * Calls are SERIALIZED through `claudeHookSyncChain` so back-to-back state
 * changes (e.g. startup auto-enable immediately followed by Stop, or rapid
 * Active <-> Observe Only toggling) cannot interleave. Without the chain, a
 * stale `isMonitoring=true` invocation could run setMonitoringActive(true)
 * AFTER a later stop already removed the files, leaving ghost presence/vote
 * files on disk while the UI says monitoring is stopped.
 *
 * Each tail in the chain re-reads the runtime state when it ACTUALLY runs
 * (not when it was queued), so the disk state always converges to the
 * latest intent regardless of how many flips happened during the in-flight
 * sync.
 */
let claudeHookSyncChain: Promise<void> = Promise.resolve();

/**
 * Enqueue an installer operation onto the serialization chain and resolve
 * with its result. Use this for ALL writes to the hook installer state so
 * that ensureInstalled, uninstallGlobal, setEnabled, etc. cannot interleave
 * across separate callers (e.g. status-bar toggle vs Uninstall command).
 *
 * Without this, ensureInstalled's ensureSettingsEntry could race with
 * uninstallGlobal's removeSettingsEntry on settings.json, with one's write
 * overwriting the other's.
 *
 * IMPORTANT: do NOT call enqueueClaudeHookOp from inside another op that
 * is already running on the chain -- the inner op would queue behind the
 * outer one and the outer would await it forever (deadlock). Direct
 * installer.* calls inside an op are fine; nested chain enqueues are not.
 */
function enqueueClaudeHookOp<T>(op: () => Promise<T>): Promise<T> {
  let outResolve!: (value: T | PromiseLike<T>) => void;
  let outReject!: (reason?: any) => void;
  const out = new Promise<T>((resolve, reject) => {
    outResolve = resolve;
    outReject = reject;
  });
  claudeHookSyncChain = claudeHookSyncChain
    .catch(() => {
      /* don't poison subsequent tails */
    })
    .then(async () => {
      try {
        outResolve(await op());
      } catch (err) {
        outReject(err);
      }
    });
  return out;
}

function syncClaudeHookState() {
  if (!claudeHookInstaller) return;
  const installer = claudeHookInstaller;
  claudeHookSyncChain = claudeHookSyncChain
    .catch(() => {
      /* don't poison subsequent tails */
    })
    .then(async () => {
      // Snapshot CURRENT state at run time. If many sync calls were queued
      // during a long-running ensureInstalled, each tail just re-reads and
      // does the right thing for the latest intent.
      const monitoring = isMonitoring;
      const autoConfirm = isAutoConfirmEnabled;
      try {
        if (monitoring) {
          // The Claude hook is machine-global and requires explicit user-level
          // consent. A workspace enabled=true cannot override a user-level
          // opt-out to install it. Terminal/WebView monitoring (codex, aider,
          // etc.) can still run -- only hook management is skipped here.
          if (!isEnabledAtUserLevel()) return;
          // ensureInstalled is idempotent and clears the sticky `uninstalled`
          // flag. We call it unconditionally rather than gated on
          // isInstalled() because a previous partial uninstall may have left
          // hook.js on disk while THIS instance's sticky is still set, and
          // skipping would leave the gate engaged.
          const r = await installer.ensureInstalled();
          if (!r.ok) {
            log(`Hook install/refresh failed: ${r.error}`);
            return;
          }
          const cfg = getConfig();
          await installer.syncConfig(
            cfg.monitorConfig.dangerousCommandPatterns
          );
          await installer.setMonitoringActive(true);
          // Re-read autoConfirm: the awaits above may have crossed a flip
          // and the snapshot at chain entry would be stale.
          await installer.setEnabled(isAutoConfirmEnabled);
        } else {
          // Stopped: drop presence + vote, stop heartbeat. Keep settings.json
          // hook entry for next time -- explicit Uninstall is the only path
          // that touches global state.
          await installer.setMonitoringActive(false);
        }
      } catch (err) {
        log(`Hook state sync failed: ${err}`);
      }
    });
}

const monitors = new Map<vscode.Terminal, TerminalMonitor>();
// Track which execution each monitor is watching, so we don't stop
// the monitor when an unrelated execution ends in the same terminal.
const monitorExecutions = new Map<
  vscode.Terminal,
  vscode.TerminalShellExecution
>();
let webviewMonitor: WebviewMonitor | null = null;

// --- Configuration ---

interface ExtensionConfig {
  enabled: boolean;
  commandPatterns: string[];
  monitorConfig: TerminalMonitorConfig;
  webviewAutoConfirm: boolean;
  webviewConfig: WebviewMonitorConfig;
}

/**
 * Returns true when llmAutoConfirm.enabled is NOT explicitly set to false at
 * the user (global) settings level.
 *
 * VS Code merges workspace settings on top of user settings, so
 * getConfig().enabled can be false for two distinct reasons:
 *   (a) User set enabled=false in their global settings -> genuine opt-out,
 *       uninstallGlobal() is appropriate.
 *   (b) A workspace .vscode/settings.json set enabled=false while user
 *       settings say true (or default) -> workspace-local preference;
 *       only THIS window should stop monitoring, the machine-global hook
 *       must NOT be removed because other workspaces / windows depend on it.
 *
 * This function distinguishes (a) from (b) by reading globalValue directly.
 */
function isEnabledAtUserLevel(): boolean {
  const cfg = vscode.workspace.getConfiguration("llmAutoConfirm");
  const insp = cfg.inspect<boolean>("enabled");
  // globalValue === undefined means no explicit user preference -> default true.
  // Only globalValue === false is a genuine user-level opt-out.
  return insp?.globalValue !== false;
}

function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("llmAutoConfirm");

  const promptRules = cfg.get<PromptRule[]>("promptRules", []);
  const cooldown = cfg.get<number>("cooldown", 1000);

  return {
    enabled: cfg.get<boolean>("enabled", true),
    commandPatterns: cfg.get<string[]>("commandPatterns", [
      "claude",
      "aider",
      "goose",
      "codex",
    ]),
    monitorConfig: {
      confirmResponse: cfg.get<string>("confirmResponse", "1"),
      cooldown,
      promptPatterns: cfg.get<string[]>("promptPatterns", []),
      promptRules,
      dangerousCommandPatterns: cfg.get<string[]>(
        "dangerousCommandPatterns",
        []
      ),
    },
    webviewAutoConfirm: cfg.get<boolean>("webviewAutoConfirm", false),
    webviewConfig: {
      pollInterval: cfg.get<number>("webviewPollInterval", 3000),
      approvalCommands: cfg.get<ApprovalCommandEntry[]>(
        "webviewApprovalCommands",
        []
      ),
      cooldown,
    },
  };
}

// --- Helpers ---

function isLLMCommand(commandLine: string, patterns: string[]): boolean {
  const trimmed = commandLine.trim().toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    const re = new RegExp(
      `(?:^|[/\\\\|&;\\s])${escapeRegex(p)}(?:\\s|$)`,
      "i"
    );
    return re.test(trimmed);
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

function debug(msg: string) {
  const cfg = vscode.workspace.getConfiguration("llmAutoConfirm");
  if (!cfg.get<boolean>("debug", false)) return;
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] [debug] ${msg}`);
}

// --- Status bar ---

function updateStatusBar() {
  const terminalCount = monitors.size;
  if (!isMonitoring) {
    statusBarItem.text = "$(circle-slash) Auto-Confirm: Stopped";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = "Click to start LLM Auto-Confirm";
  } else {
    const mode = isWebviewEnabled ? "Terminal+WebView" : "Terminal";
    const stateLabel = isAutoConfirmEnabled ? "Active" : "Observe Only";
    const icon = isAutoConfirmEnabled ? "$(eye)" : "$(debug-pause)";
    const debugOn = vscode.workspace
      .getConfiguration("llmAutoConfirm")
      .get<boolean>("debug", false);
    const debugSuffix = debugOn ? " [debug]" : "";
    if (terminalCount > 0) {
      statusBarItem.text = `${icon} Auto-Confirm: Watching (${stateLabel}) [${mode}]${debugSuffix}`;
    } else {
      statusBarItem.text = `${icon} Auto-Confirm: ${stateLabel} [${mode}]${debugSuffix}`;
    }
    statusBarItem.backgroundColor = isAutoConfirmEnabled
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    statusBarItem.tooltip = [
      `State: ${stateLabel}`,
      `Mode: ${mode}`,
      `Debug logging: ${debugOn ? "on" : "off"}`,
      terminalCount > 0
        ? `Monitoring ${terminalCount} terminal(s)`
        : "Waiting for LLM commands",
      isAutoConfirmEnabled
        ? "Click to switch to observe-only mode"
        : "Click to resume auto-confirm",
      "Use Start/Stop commands in the Command Palette to fully start or stop monitoring",
    ].join("\n");
  }
  statusBarItem.show();
}

// --- Start / Stop ---

function startMonitoring() {
  const config = getConfig();
  // Honor "inert when disabled": the merged workspace+user config value
  // decides whether terminal/WebView monitoring starts. The user-level
  // (global) value only controls Claude hook installation (see
  // syncClaudeHookState), so a workspace enabled=true can still start
  // codex/aider terminal monitoring even when the user globally opted
  // out of the machine-wide Claude hook.
  if (!config.enabled) {
    vscode.window.showWarningMessage(
      "LLM Auto-Confirm is disabled in settings (llmAutoConfirm.enabled=false). Enable it in settings before starting."
    );
    log("startMonitoring rejected: llmAutoConfirm.enabled=false.");
    return;
  }
  isMonitoring = true;
  isAutoConfirmEnabled = true;

  // Start webview monitor if configured
  if (config.webviewAutoConfirm) {
    startWebviewMonitor(config);
  }

  syncClaudeHookState();
  updateStatusBar();
  log("Auto-confirm active. Listening for LLM commands in terminals...");
  vscode.window.showInformationMessage("LLM Auto-Confirm active.");
}

function stopMonitoring() {
  isMonitoring = false;
  isAutoConfirmEnabled = false;
  for (const [terminal, monitor] of monitors) {
    monitor.stop();
    log(`Stopped monitoring terminal: ${terminal.name}`);
  }
  monitors.clear();
  monitorExecutions.clear();
  stopWebviewMonitor();
  syncClaudeHookState();
  updateStatusBar();
  // Defer the user-facing "stopped" message until the sync chain resolves.
  // syncClaudeHookState() only queues setMonitoringActive(false); if a prior
  // operation is still in the chain the vote file can remain live until it
  // finishes. Showing the toast only after the chain confirms the file is
  // unlinked prevents a window where the user thinks they're stopped but
  // the hook can still approve the next tool call.
  claudeHookSyncChain.catch(() => {}).then(() => {
    log("Auto-confirm stopped.");
    vscode.window.showInformationMessage("LLM Auto-Confirm stopped.");
  });
}

/**
 * Stronger than stopMonitoring: this is the path the extension takes when
 * the user sets `llmAutoConfirm.enabled=false` in config. The Stop command
 * just pauses this window's monitoring (keeps the global hook installed for
 * later resume / for other windows). But config-level disable means "don't
 * mutate my Claude config at all" -- so we additionally run uninstallGlobal
 * which removes settings.json hook entry + ~/.claude/llm-auto-confirm/ if
 * no other VS Code windows are alive. The sticky uninstalled flag set by
 * uninstallGlobal also prevents any later setEnabled / syncConfig in this
 * instance from silently rewriting the files; they only come back if the
 * user flips enabled back to true (which routes through ensureInstalled).
 */
async function disableMonitoringGlobally() {
  isMonitoring = false;
  isAutoConfirmEnabled = false;
  for (const [terminal, monitor] of monitors) {
    monitor.stop();
    log(`Stopped monitoring terminal: ${terminal.name}`);
  }
  monitors.clear();
  monitorExecutions.clear();
  stopWebviewMonitor();
  let hookCleanupOk = !claudeHookInstaller; // trivially ok when no installer
  if (claudeHookInstaller) {
    try {
      const r = await claudeHookInstaller.uninstallGlobal();
      log(
        `Config disabled: hook uninstall ${r.fullCleanup ? "FULL" : `PARTIAL (${r.otherLiveWindows} other live)`}.`
      );
      hookCleanupOk = true;
    } catch (err) {
      // removeSettingsEntry() threw (e.g. settings.json is malformed).
      // hookDir was intentionally NOT deleted; the dangling entry still
      // points at an existing hook.js so Claude Code can still run it.
      log(`Config disabled: hook uninstall error: ${err}`);
    }
  }
  updateStatusBar();
  if (hookCleanupOk) {
    log("Auto-confirm disabled (config). Claude hook removed.");
    vscode.window.showInformationMessage(
      "LLM Auto-Confirm disabled. Claude hook removed (full cleanup if no other windows were using it)."
    );
  } else {
    log("Auto-confirm disabled (config). Claude hook removal failed; check output for details.");
    vscode.window.showWarningMessage(
      "LLM Auto-Confirm disabled, but Claude hook cleanup failed (settings.json may be malformed). Check the Output panel and fix manually."
    );
  }
}

function toggleMonitoring() {
  if (!isMonitoring) {
    startMonitoring();
  } else {
    isAutoConfirmEnabled = !isAutoConfirmEnabled;
    syncClaudeHookState();
    updateStatusBar();
    log(
      isAutoConfirmEnabled
        ? "Auto-confirm resumed. Prompt matches will be approved."
        : "Auto-confirm paused. Continuing to watch terminals in observe-only mode."
    );
    vscode.window.showInformationMessage(
      isAutoConfirmEnabled
        ? "LLM Auto-Confirm active."
        : "LLM Auto-Confirm paused. Still watching terminals."
    );
  }
}

// --- WebView monitor management ---

function startWebviewMonitor(config?: ExtensionConfig) {
  if (webviewMonitor) {
    webviewMonitor.stop();
  }
  const cfg = config ?? getConfig();
  isWebviewEnabled = true;
  webviewMonitor = new WebviewMonitor(
    cfg.webviewConfig,
    () => isAutoConfirmEnabled,
    log,
    debug
  );
  webviewMonitor.onCommandExecuted = () => {
    updateStatusBar();
  };
  webviewMonitor.start();
  log("WebView command-based auto-confirm enabled.");
}

function stopWebviewMonitor() {
  isWebviewEnabled = false;
  if (webviewMonitor) {
    webviewMonitor.stop();
    webviewMonitor = null;
  }
}

async function setDebugLogging(value: boolean) {
  const cfg = vscode.workspace.getConfiguration("llmAutoConfirm");
  await cfg.update("debug", value, vscode.ConfigurationTarget.Global);
  log(`Debug logging ${value ? "enabled" : "disabled"}.`);
  vscode.window.showInformationMessage(
    `LLM Auto-Confirm: debug logging ${value ? "ON" : "OFF"}.`
  );
  // Context key + status bar refresh happen via the onDidChangeConfiguration handler.
}

function syncDebugContext() {
  const debugOn = vscode.workspace
    .getConfiguration("llmAutoConfirm")
    .get<boolean>("debug", false);
  vscode.commands.executeCommand(
    "setContext",
    "llmAutoConfirm.debug",
    debugOn
  );
}

function toggleWebviewMonitor() {
  if (isWebviewEnabled) {
    stopWebviewMonitor();
    log("WebView auto-confirm disabled.");
    vscode.window.showInformationMessage(
      "LLM Auto-Confirm: WebView mode disabled."
    );
  } else {
    const config = getConfig();
    // Honor "inert when disabled": only the merged config value gates
    // WebView monitoring (same reasoning as startMonitoring -- user-level
    // only controls Claude hook installation, not terminal/WebView monitoring).
    if (!config.enabled) {
      vscode.window.showWarningMessage(
        "LLM Auto-Confirm is disabled in settings (llmAutoConfirm.enabled=false). Enable it in settings before toggling WebView mode."
      );
      log("toggleWebviewMonitor rejected: llmAutoConfirm.enabled=false.");
      return;
    }
    if (!isMonitoring) {
      // Also enable the main monitoring; this implicitly re-arms the Claude
      // hook sentinel so the resumed session is consistent across paths.
      isMonitoring = true;
      isAutoConfirmEnabled = true;
      syncClaudeHookState();
    }
    startWebviewMonitor();
    vscode.window.showInformationMessage(
      "LLM Auto-Confirm: WebView mode enabled (command-based)."
    );
  }
  updateStatusBar();
}

// --- Extension activation ---

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("LLM Auto-Confirm");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "llm-auto-confirm.toggle";
  syncDebugContext();
  updateStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand("llm-auto-confirm.start", startMonitoring),
    vscode.commands.registerCommand("llm-auto-confirm.stop", stopMonitoring),
    vscode.commands.registerCommand(
      "llm-auto-confirm.toggle",
      toggleMonitoring
    ),
    vscode.commands.registerCommand(
      "llm-auto-confirm.toggleWebview",
      toggleWebviewMonitor
    ),
    vscode.commands.registerCommand("llm-auto-confirm.enableDebug", () =>
      setDebugLogging(true)
    ),
    vscode.commands.registerCommand("llm-auto-confirm.disableDebug", () =>
      setDebugLogging(false)
    ),
    vscode.commands.registerCommand(
      "llm-auto-confirm.uninstallClaudeHook",
      () => uninstallClaudeHookCommand()
    ),
    vscode.commands.registerCommand(
      "llm-auto-confirm.reinstallClaudeHook",
      () => reinstallClaudeHookCommand()
    ),
    statusBarItem,
    outputChannel
  );

  // Install/refresh the Claude Code PreToolUse hook so prompts never appear.
  // The terminal monitor stays as a fallback (and remains the path for codex).
  // A fresh UUID per activate() call gives a truly per-window identifier:
  // vscode.env.sessionId is shared by all windows in the same application
  // session and would cause different windows to collide on the same
  // sessions/, windows/, and config-*.json files.
  const windowSessionId = randomUUID();
  claudeHookInstaller = new ClaudeHookInstaller(
    context.extensionPath,
    windowSessionId,
    log
  );
  // Chain initializeClaudeHook into the same serialization chain as
  // syncClaudeHookState. Otherwise the auto-start sync at the bottom of
  // activate() (which calls syncClaudeHookState) could fire ensureInstalled
  // CONCURRENTLY with this initialize call, both trying to write the same
  // files.
  claudeHookSyncChain = claudeHookSyncChain
    .catch(() => {
      /* don't poison subsequent tails */
    })
    .then(initializeClaudeHook);

  // Core: auto-detect LLM commands in any terminal
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(async (e) => {
      if (!isMonitoring) return;

      const config = getConfig();
      const commandLine = e.execution.commandLine.value;

      // If this terminal already has a monitor, attach the new execution
      // so we can read prompt output that appears between commands
      const existingMonitor = monitors.get(e.terminal);
      if (existingMonitor) {
        log(
          `Sub-command in monitored terminal: "${commandLine.substring(0, 80)}" in ${e.terminal.name}`
        );
        existingMonitor.attachExecution(e.execution);
        return;
      }

      if (!isLLMCommand(commandLine, config.commandPatterns)) return;

      log(
        `Detected LLM command: "${commandLine}" in terminal: ${e.terminal.name}`
      );

      const monitor = new TerminalMonitor(
        e.terminal,
        e.execution,
        config.monitorConfig,
        () => isAutoConfirmEnabled,
        log,
        debug
      );

      monitor.onConfirm = () => {
        updateStatusBar();
      };

      monitor.onSuppressed = () => {};

      monitor.onDangerousBlocked = (promptText) => {
        vscode.window.showWarningMessage(
          `LLM Auto-Confirm blocked a dangerous command: ${promptText}`
        );
      };

      monitor.onError = (error) => {
        log(`Monitor error: ${error}`);
      };

      monitors.set(e.terminal, monitor);
      monitorExecutions.set(e.terminal, e.execution);
      updateStatusBar();

      monitor.start();
    })
  );

  // Cleanup when the MONITORED execution ends (not unrelated sub-commands)
  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      const trackedExecution = monitorExecutions.get(e.terminal);
      if (trackedExecution && trackedExecution === e.execution) {
        const monitor = monitors.get(e.terminal);
        if (monitor) {
          monitor.stop();
          monitors.delete(e.terminal);
          monitorExecutions.delete(e.terminal);
          log(`LLM command ended in terminal: ${e.terminal.name}`);
          updateStatusBar();
        }
      } else {
        log(
          `Ignored sub-command end in terminal: ${e.terminal.name} (monitor still active)`
        );
      }
    })
  );

  // Cleanup when terminal is closed
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      const monitor = monitors.get(terminal);
      if (monitor) {
        monitor.stop();
        monitors.delete(terminal);
        monitorExecutions.delete(terminal);
        log(`Terminal closed: ${terminal.name}`);
        updateStatusBar();
      }
    })
  );

  // React to config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("llmAutoConfirm")) return;
      syncDebugContext();
      const config = getConfig();

      // Detect config.enabled flip explicitly. Previously this branch was
      // gated on `config.enabled !== isMonitoring`, but that conflates two
      // different signals: Stop/Start commands can desync isMonitoring from
      // config.enabled, so e.g. Stop-then-config-disable would leave
      // isMonitoring=false=config.enabled, the condition false, and the
      // uninstall never running. Tracking prevConfigEnabled separately
      // ensures the disable path runs whenever the user actually flips the
      // config value, regardless of whether monitoring was already stopped.
      const userLevelEnabled = isEnabledAtUserLevel();
      const configEnabledFlipped = prevConfigEnabled !== config.enabled;
      const userLevelFlipped = prevUserLevelEnabled !== userLevelEnabled;
      prevConfigEnabled = config.enabled;
      prevUserLevelEnabled = userLevelEnabled;
      if (configEnabledFlipped || userLevelFlipped) {
        if (!userLevelEnabled) {
          // User-level disable (globalValue=false). Always remove the
          // machine-global Claude hook. Whether to stop terminal/WebView
          // monitoring depends on the merged config: if a workspace override
          // keeps merged enabled=true, terminals keep running (codex/aider
          // still useful) -- only the hook is removed.
          claudeHookSyncChain = claudeHookSyncChain
            .catch(() => {
              /* don't poison subsequent tails */
            })
            .then(async () => {
              if (!getConfig().enabled) {
                // Merged also disabled (no workspace override): full stop.
                await disableMonitoringGlobally();
              } else {
                // Workspace re-enables terminals: only remove the hook.
                if (claudeHookInstaller) {
                  try {
                    const r = await claudeHookInstaller.uninstallGlobal();
                    log(
                      `User-level disabled: hook ${r.fullCleanup ? "FULL" : `PARTIAL (${r.otherLiveWindows} other live)`} uninstall. Terminal monitoring continues (workspace override).`
                    );
                  } catch (err) {
                    log(`User-level disabled: hook uninstall error: ${err}`);
                  }
                }
              }
            });
        } else if (!config.enabled) {
          // Workspace-local override: .vscode/settings.json enabled=false
          // while user settings say true (or default). Only stop monitoring
          // in this window; leave the machine-global hook intact so other
          // workspaces / windows are not affected.
          stopMonitoring();
        } else {
          // Both user-level and merged config.enabled are true. Queue so any
          // pending disable runs first. If already monitoring (workspace kept
          // terminals running while user was opted out), re-sync hook state
          // so the now-permitted hook gets installed.
          claudeHookSyncChain = claudeHookSyncChain
            .catch(() => {
              /* don't poison subsequent tails */
            })
            .then(() => {
              if (getConfig().enabled && isEnabledAtUserLevel()) {
                if (!isMonitoring) {
                  startMonitoring();
                } else {
                  // Terminals already running; sync hook now that user-level
                  // consent is restored.
                  syncClaudeHookState();
                }
              }
            });
        }
      }

      // Update terminal monitors
      for (const monitor of monitors.values()) {
        monitor.updateConfig(config.monitorConfig);
      }

      // Update webview monitor
      if (config.webviewAutoConfirm !== isWebviewEnabled) {
        if (config.webviewAutoConfirm && isMonitoring) {
          startWebviewMonitor(config);
        } else {
          stopWebviewMonitor();
        }
      } else if (webviewMonitor) {
        webviewMonitor.updateConfig(config.webviewConfig);
      }

      // Push fresh dangerous-command blacklist out to the hook script -- but
      // ONLY if this window is actively monitoring AND enabled AND installed.
      // Three separate guards:
      //   1. isMonitoring: a stopped window must not re-write its config-<id>.json
      //      after settings change -- setMonitoringActive(false) removed the file
      //      precisely to stop this window from bleeding patterns into other active
      //      windows. Without this guard, any settings edit would recreate the file.
      //   2. config.enabled: a disabled window (workspace override) must not
      //      write its workspace-local patterns into the shared hook config,
      //      since that would affect Claude sessions in other enabled windows.
      //   3. isInstalled(): prevents creating the hook directory in a window
      //      that never ran ensureInstalled (preserves "inert when disabled").
      //
      // Chained (not fire-and-forget) so a config change immediately
      // followed by VS Code shutdown still gets persisted -- deactivate()
      // drains this chain before exiting.
      if (claudeHookInstaller && claudeHookInstaller.isInstalled() && config.enabled && isMonitoring) {
        const installer = claudeHookInstaller;
        const patterns = config.monitorConfig.dangerousCommandPatterns;
        claudeHookSyncChain = claudeHookSyncChain
          .catch(() => {
            /* don't poison subsequent tails */
          })
          .then(() => installer.syncConfig(patterns));
      }

      updateStatusBar();
      log("Configuration updated.");
    })
  );

  // Auto-start if the merged (workspace+user) config enables it. User-level
  // opt-out only blocks Claude hook installation (handled in syncClaudeHookState),
  // not terminal/WebView monitoring. A workspace enabled=true legitimately
  // re-enables codex/aider monitoring even when the user globally opted out
  // of the machine-wide Claude hook.
  const initialConfig = getConfig();
  prevConfigEnabled = initialConfig.enabled;
  prevUserLevelEnabled = isEnabledAtUserLevel();
  if (initialConfig.enabled) {
    isMonitoring = true;
    isAutoConfirmEnabled = true;
    if (initialConfig.webviewAutoConfirm) {
      startWebviewMonitor(initialConfig);
    }
    syncClaudeHookState();
    updateStatusBar();
    log(
      `Extension activated. Auto-confirm active. WebView: ${initialConfig.webviewAutoConfirm ? "on" : "off"}.`
    );
  } else {
    log("Extension activated. Auto-confirm stopped.");
  }
}

async function initializeClaudeHook(): Promise<void> {
  if (!claudeHookInstaller) return;

  if (!isEnabledAtUserLevel()) {
    // User explicitly disabled the extension in their global (user) settings.
    // onDidChangeConfiguration only fires for live config flips, so a hook
    // installed in a prior session survives in ~/.claude/settings.json unless
    // we remove it here. Call uninstallGlobal() quietly (no toast -- the user
    // already opted out; a log entry is sufficient).
    try {
      const r = await claudeHookInstaller.uninstallGlobal();
      log(
        `Startup (user disabled): hook uninstall ${
          r.fullCleanup
            ? "FULL"
            : `PARTIAL (${r.otherLiveWindows} other live window(s))`
        }.`
      );
    } catch (err) {
      log(`Startup (user disabled): hook uninstall error: ${err}`);
    }
    return;
  }

  const cfg = getConfig();
  // Skip hook setup when the workspace has disabled the extension locally.
  // Without this gate, an idle/disabled window would still write its
  // settings.json hook entry + presence file, which (a) silently mutates
  // the user's Claude config they never opted into, and (b) makes another
  // window's "Uninstall Claude Code Hook" go partial (count this window as
  // alive) when it should be full.
  if (!cfg.enabled) {
    // Workspace-local override: user-level is not disabled, so leave global
    // hook artifacts intact for other windows / workspaces. Only clean up
    // this window's per-window state so it doesn't count as alive.
    //
    // pruneOrphanedVotes() additionally removes stale files from crashed
    // prior sessions (>90 s stale) to prevent false approvals for up to
    // SESSION_MAX_AGE_MS (10 min) after a crash.
    await claudeHookInstaller.cleanupSession();
    await claudeHookInstaller.pruneOrphanedVotes();
    return;
  }
  const wasInstalled = claudeHookInstaller.isInstalled();
  const result = await claudeHookInstaller.ensureInstalled();
  if (!result.ok) {
    vscode.window.showWarningMessage(
      `LLM Auto-Confirm: failed to install Claude Code hook (${result.error}). The terminal-monitor fallback will still try to confirm prompts.`
    );
    return;
  }
  await claudeHookInstaller.syncConfig(
    cfg.monitorConfig.dangerousCommandPatterns
  );
  // Prune stale vote/presence files from sessions that crashed or were
  // force-killed before cleanupSession() ran. Without this, a prior crash
  // leaves a fresh-looking sessions/<id> file for the full 10-minute TTL,
  // during which Claude tool calls are auto-approved by the hook even though
  // no live window is voting. Pruning here (after ensureInstalled, before
  // this window's own vote is written) caps the blast radius to ~90 seconds.
  await claudeHookInstaller.pruneOrphanedVotes();
  // Establish initial monitoring + vote state. setMonitoringActive(true)
  // writes presence + starts heartbeat; setEnabled writes the vote (or not).
  if (isMonitoring) {
    await claudeHookInstaller.setMonitoringActive(true);
    await claudeHookInstaller.setEnabled(isAutoConfirmEnabled);
  } else {
    // enabled=true in config but monitoring is off (rare -- e.g. someone
    // toggled it off before activate finished). Stay quiet.
    await claudeHookInstaller.setMonitoringActive(false);
  }

  if (!wasInstalled) {
    const paths = claudeHookInstaller.describePaths();
    vscode.window.showInformationMessage(
      `LLM Auto-Confirm: installed Claude Code PreToolUse hook (${paths.hookDir}). Toggle from the status bar to enable/disable for THIS window. Other VS Code windows manage their own state independently. If you uninstall this extension, the hook becomes inert within ~10 minutes for this window's vote. For immediate cleanup, run "Uninstall Claude Code Hook" first.`
    );
    log(`Hook installed: settings=${paths.settings}, dir=${paths.hookDir}`);
  } else if (result.scriptChanged || result.settingsChanged) {
    log(
      `Hook refreshed: scriptChanged=${result.scriptChanged}, settingsChanged=${result.settingsChanged}`
    );
  }
}

async function uninstallClaudeHookCommand(): Promise<void> {
  if (!claudeHookInstaller) return;
  const choice = await vscode.window.showWarningMessage(
    "Uninstall the Claude Code hook? Always removes THIS window's session vote. Will only remove the entry from ~/.claude/settings.json and delete ~/.claude/llm-auto-confirm/ if no other VS Code windows are actively using the hook.",
    { modal: true },
    "Uninstall"
  );
  if (choice !== "Uninstall") return;
  // Stop terminal + webview monitors immediately. The hook artifacts are
  // removed below, but the legacy terminal-scraping path would keep auto-
  // approving prompts until the next VS Code restart without this shutdown.
  if (isMonitoring) {
    isMonitoring = false;
    isAutoConfirmEnabled = false;
    for (const [terminal, monitor] of monitors) {
      monitor.stop();
      log(`Stopped monitoring terminal: ${terminal.name}`);
    }
    monitors.clear();
    monitorExecutions.clear();
    stopWebviewMonitor();
    updateStatusBar();
  }
  try {
    // userInitiated=true: sets the stronger `userUninstalled` sticky so this
    // command is durable across status-bar toggles / Start within this
    // session. Only "Reinstall Claude Code Hook" lifts it.
    //
    // Enqueued through claudeHookSyncChain so it can't interleave with an
    // in-flight ensureInstalled/setMonitoringActive elsewhere -- otherwise
    // ensureSettingsEntry and removeSettingsEntry could race on
    // settings.json with the loser's write overwriting the winner's.
    const installer = claudeHookInstaller;
    const result = await enqueueClaudeHookOp(() =>
      installer.uninstallGlobal({ userInitiated: true })
    );
    if (result.fullCleanup) {
      vscode.window.showInformationMessage(
        "LLM Auto-Confirm: Claude Code hook fully uninstalled (no other windows were using it). The extension will reinstall it automatically on the next VS Code reload -- run \"Reinstall Claude Code Hook\" to put it back sooner. To keep it gone, disable or uninstall this extension before reloading."
      );
      log("Hook fully uninstalled by user request.");
    } else {
      vscode.window.showInformationMessage(
        `LLM Auto-Confirm: removed this window's session only. ${result.otherLiveWindows} other VS Code window(s) still alive (active OR paused) -- settings.json entry and hook directory left intact for them. Run "Uninstall Claude Code Hook" in those windows too (or close them) to fully remove.`
      );
      log(
        `Hook partially uninstalled (this window only); ${result.otherLiveWindows} other live window(s) preserved.`
      );
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `LLM Auto-Confirm: uninstall failed -- ${err}`
    );
  }
}

async function reinstallClaudeHookCommand(): Promise<void> {
  if (!claudeHookInstaller) return;
  const cfg = getConfig();
  if (!cfg.enabled || !isEnabledAtUserLevel()) {
    // Honor "inert when disabled". User must enable in settings first;
    // we don't unilaterally rewrite their config.
    vscode.window.showWarningMessage(
      "LLM Auto-Confirm is disabled in settings (llmAutoConfirm.enabled=false). Enable it in settings before reinstalling the Claude Code hook."
    );
    log("Reinstall rejected: llmAutoConfirm.enabled=false.");
    return;
  }
  const installer = claudeHookInstaller;
  // Whole reinstall sequence enqueued atomically through the chain so it
  // can't interleave with concurrent syncs/uninstalls on settings.json.
  const result = await enqueueClaudeHookOp(async () => {
    // reinstall() (not ensureInstalled directly): clears the stronger
    // `userUninstalled` sticky AND the pending-uninstall marker so a prior
    // Uninstall command in this or another window is lifted.
    const r = await installer.reinstall();
    if (!r.ok) return r;
    const cfg = getConfig();
    await installer.syncConfig(cfg.monitorConfig.dangerousCommandPatterns);
    // Re-establish this window's monitoring/vote state from the live
    // runtime variables (read at run time, not closure-captured at queue
    // time, since the chain may have processed other ops first).
    if (isMonitoring) {
      await installer.setMonitoringActive(true);
      await installer.setEnabled(isAutoConfirmEnabled);
    } else {
      await installer.setMonitoringActive(false);
    }
    return r;
  });
  if (!result.ok) {
    vscode.window.showErrorMessage(
      `LLM Auto-Confirm: reinstall failed -- ${result.error}`
    );
    return;
  }
  vscode.window.showInformationMessage(
    "LLM Auto-Confirm: Claude Code hook reinstalled."
  );
  log("Hook reinstalled by user request.");
}

export async function deactivate(): Promise<void> {
  for (const monitor of monitors.values()) {
    monitor.stop();
  }
  monitors.clear();
  monitorExecutions.clear();
  if (webviewMonitor) {
    webviewMonitor.stop();
    webviewMonitor = null;
  }
  // CRITICAL: deactivate must NOT touch global hook state on a generic
  // window close, only this window's own session file. Other windows may
  // still be actively using the hook.
  //
  // EXCEPTION: if a previous user-initiated Uninstall command left a
  // pending-uninstall marker AND this window is the last one alive,
  // cleanupSession finishes the global cleanup on the user's behalf. That
  // logic lives in ClaudeHookInstaller.cleanupSession().
  //
  // Two awaits are required:
  //   1) Drain claudeHookSyncChain. A config-driven disable just before
  //      shutdown enqueues uninstallGlobal there; without draining, VS Code
  //      can exit before that uninstall completes and leave the hook
  //      installed despite the user explicitly disabling in settings.
  //   2) Then cleanupSession, so the unlink + (possibly) finishGlobalCleanup
  //      complete before the host process exits.
  if (claudeHookInstaller) {
    try {
      await claudeHookSyncChain;
    } catch {
      /* don't block shutdown on chain failures */
    }
    await claudeHookInstaller.cleanupSession();
  }
}
