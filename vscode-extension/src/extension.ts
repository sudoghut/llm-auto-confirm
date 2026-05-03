import * as vscode from "vscode";
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

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let isMonitoring = false;
let isAutoConfirmEnabled = false;
let isWebviewEnabled = false;

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
  isMonitoring = true;
  isAutoConfirmEnabled = true;
  const config = getConfig();

  // Start webview monitor if configured
  if (config.webviewAutoConfirm) {
    startWebviewMonitor(config);
  }

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
  updateStatusBar();
  log("Auto-confirm stopped.");
  vscode.window.showInformationMessage("LLM Auto-Confirm stopped.");
}

function toggleMonitoring() {
  if (!isMonitoring) {
    startMonitoring();
  } else {
    isAutoConfirmEnabled = !isAutoConfirmEnabled;
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
    if (!isMonitoring) {
      // Also enable the main monitoring
      isMonitoring = true;
      isAutoConfirmEnabled = true;
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
    statusBarItem,
    outputChannel
  );

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

      if (config.enabled !== isMonitoring) {
        if (config.enabled) {
          startMonitoring();
        } else {
          stopMonitoring();
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

      updateStatusBar();
      log("Configuration updated.");
    })
  );

  // Auto-start if configured
  const initialConfig = getConfig();
  if (initialConfig.enabled) {
    isMonitoring = true;
    isAutoConfirmEnabled = true;
    if (initialConfig.webviewAutoConfirm) {
      startWebviewMonitor(initialConfig);
    }
    updateStatusBar();
    log(
      `Extension activated. Auto-confirm active. WebView: ${initialConfig.webviewAutoConfirm ? "on" : "off"}.`
    );
  } else {
    log("Extension activated. Auto-confirm stopped.");
  }
}

export function deactivate() {
  for (const monitor of monitors.values()) {
    monitor.stop();
  }
  monitors.clear();
  monitorExecutions.clear();
  if (webviewMonitor) {
    webviewMonitor.stop();
    webviewMonitor = null;
  }
}
