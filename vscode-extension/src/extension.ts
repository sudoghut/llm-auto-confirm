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
let isEnabled = false;
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
  if (!isEnabled) {
    statusBarItem.text = "$(circle-slash) Auto-Confirm: Off";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = "Click to enable LLM Auto-Confirm";
  } else {
    const mode = isWebviewEnabled ? "Terminal+WebView" : "Terminal";
    if (terminalCount > 0) {
      statusBarItem.text = `$(eye) Auto-Confirm: Watching [${mode}]`;
    } else {
      statusBarItem.text = `$(check) Auto-Confirm: On [${mode}]`;
    }
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    statusBarItem.tooltip = [
      `Mode: ${mode}`,
      terminalCount > 0
        ? `Monitoring ${terminalCount} terminal(s)`
        : "Waiting for LLM commands",
      "Click to disable",
    ].join("\n");
  }
  statusBarItem.show();
}

// --- Start / Stop ---

function startMonitoring() {
  isEnabled = true;
  const config = getConfig();

  // Start webview monitor if configured
  if (config.webviewAutoConfirm) {
    startWebviewMonitor(config);
  }

  updateStatusBar();
  log("Auto-confirm enabled. Listening for LLM commands in terminals...");
  vscode.window.showInformationMessage("LLM Auto-Confirm enabled.");
}

function stopMonitoring() {
  isEnabled = false;
  for (const [terminal, monitor] of monitors) {
    monitor.stop();
    log(`Stopped monitoring terminal: ${terminal.name}`);
  }
  monitors.clear();
  monitorExecutions.clear();
  stopWebviewMonitor();
  updateStatusBar();
  log("Auto-confirm disabled.");
  vscode.window.showInformationMessage("LLM Auto-Confirm disabled.");
}

function toggleMonitoring() {
  if (isEnabled) {
    stopMonitoring();
  } else {
    startMonitoring();
  }
}

// --- WebView monitor management ---

function startWebviewMonitor(config?: ExtensionConfig) {
  if (webviewMonitor) {
    webviewMonitor.stop();
  }
  const cfg = config ?? getConfig();
  isWebviewEnabled = true;
  webviewMonitor = new WebviewMonitor(cfg.webviewConfig, log, debug);
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

function toggleWebviewMonitor() {
  if (isWebviewEnabled) {
    stopWebviewMonitor();
    log("WebView auto-confirm disabled.");
    vscode.window.showInformationMessage(
      "LLM Auto-Confirm: WebView mode disabled."
    );
  } else {
    if (!isEnabled) {
      // Also enable the main monitoring
      isEnabled = true;
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
    statusBarItem,
    outputChannel
  );

  // Core: auto-detect LLM commands in any terminal
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(async (e) => {
      if (!isEnabled) return;

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
        log,
        debug
      );

      monitor.onConfirm = () => {
        updateStatusBar();
      };

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
      const config = getConfig();

      if (config.enabled !== isEnabled) {
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
        if (config.webviewAutoConfirm && isEnabled) {
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
    isEnabled = true;
    if (initialConfig.webviewAutoConfirm) {
      startWebviewMonitor(initialConfig);
    }
    updateStatusBar();
    log(
      `Extension activated. Auto-confirm enabled. WebView: ${initialConfig.webviewAutoConfirm ? "on" : "off"}.`
    );
  } else {
    log("Extension activated. Auto-confirm disabled.");
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
