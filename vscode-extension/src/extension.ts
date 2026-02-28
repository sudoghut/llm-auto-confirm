import * as vscode from "vscode";
import { TerminalMonitor, TerminalMonitorConfig } from "./terminal-monitor";

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let isEnabled = false;
let totalConfirms = 0;

const monitors = new Map<vscode.Terminal, TerminalMonitor>();

interface ExtensionConfig {
  enabled: boolean;
  commandPatterns: string[];
  monitorConfig: TerminalMonitorConfig;
}

function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("llmAutoConfirm");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    commandPatterns: cfg.get<string[]>("commandPatterns", [
      "claude",
      "aider",
      "goose",
      "codex",
    ]),
    monitorConfig: {
      confirmResponse: cfg.get<string>("confirmResponse", "y"),
      cooldown: cfg.get<number>("cooldown", 1000),
      promptPatterns: cfg.get<string[]>("promptPatterns", []),
      dangerousCommandPatterns: cfg.get<string[]>(
        "dangerousCommandPatterns",
        []
      ),
    },
  };
}

function isLLMCommand(commandLine: string, patterns: string[]): boolean {
  const trimmed = commandLine.trim().toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    // Match as standalone command, after path separator, or after npx/pipe/&&
    const re = new RegExp(`(?:^|[/\\\\|&;\\s])${escapeRegex(p)}(?:\\s|$)`, "i");
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

function updateStatusBar() {
  const activeCount = monitors.size;
  if (!isEnabled) {
    statusBarItem.text = "$(circle-slash) Auto-Confirm: Off";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = "Click to enable LLM Auto-Confirm";
  } else if (activeCount > 0) {
    statusBarItem.text = `$(eye) Auto-Confirm: Watching (${totalConfirms})`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    statusBarItem.tooltip = `Monitoring ${activeCount} terminal(s). Total confirms: ${totalConfirms}. Click to disable.`;
  } else {
    statusBarItem.text = `$(check) Auto-Confirm: On (${totalConfirms})`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    statusBarItem.tooltip =
      "Waiting for LLM commands in terminals. Click to disable.";
  }
  statusBarItem.show();
}

function startMonitoring() {
  isEnabled = true;
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
    statusBarItem,
    outputChannel
  );

  // Core: auto-detect LLM commands in any terminal
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(async (e) => {
      if (!isEnabled) return;

      const config = getConfig();
      const commandLine = e.execution.commandLine.value;

      if (!isLLMCommand(commandLine, config.commandPatterns)) return;

      log(
        `Detected LLM command: "${commandLine}" in terminal: ${e.terminal.name}`
      );

      // Stop any existing monitor on this terminal
      if (monitors.has(e.terminal)) {
        monitors.get(e.terminal)!.stop();
      }

      const monitor = new TerminalMonitor(
        e.terminal,
        e.execution,
        config.monitorConfig,
        log
      );

      monitor.onConfirm = () => {
        totalConfirms++;
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
      updateStatusBar();

      // Start monitoring (runs the async read loop)
      monitor.start();
    })
  );

  // Cleanup when command execution ends
  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      const monitor = monitors.get(e.terminal);
      if (monitor) {
        monitor.stop();
        monitors.delete(e.terminal);
        log(`Command ended in terminal: ${e.terminal.name}`);
        updateStatusBar();
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

      // Update all active monitors with new config
      for (const monitor of monitors.values()) {
        monitor.updateConfig(config.monitorConfig);
      }

      log("Configuration updated.");
    })
  );

  // Auto-start if configured
  const { enabled } = getConfig();
  if (enabled) {
    isEnabled = true;
    updateStatusBar();
    log(
      "Extension activated. Auto-confirm enabled, listening for LLM commands..."
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
}
