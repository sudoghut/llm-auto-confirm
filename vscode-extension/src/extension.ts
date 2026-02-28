import * as vscode from "vscode";
import { CDPClient } from "./cdp-client";
import { AutoClicker, AutoClickerConfig } from "./auto-clicker";

let cdpClient: CDPClient | null = null;
let autoClicker: AutoClicker | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

function getConfig(): {
  debugPort: number;
  autoClickerConfig: AutoClickerConfig;
  enabled: boolean;
} {
  const cfg = vscode.workspace.getConfiguration("llmAutoConfirm");
  return {
    debugPort: cfg.get<number>("debugPort", 9222),
    enabled: cfg.get<boolean>("enabled", false),
    autoClickerConfig: {
      pollingInterval: cfg.get<number>("pollingInterval", 2000),
      clickCooldown: cfg.get<number>("clickCooldown", 1000),
      buttonSelectors: cfg.get<string[]>("buttonSelectors", []),
      buttonTextPatterns: cfg.get<string[]>("buttonTextPatterns", []),
      dangerousCommandPatterns: cfg.get<string[]>(
        "dangerousCommandPatterns",
        []
      ),
    },
  };
}

function updateStatusBar(state: "off" | "connecting" | "active" | "error") {
  switch (state) {
    case "off":
      statusBarItem.text = "$(circle-slash) Auto-Confirm: Off";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.tooltip = "Click to start LLM Auto-Confirm";
      break;
    case "connecting":
      statusBarItem.text = "$(sync~spin) Auto-Confirm: Connecting...";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.tooltip = "Connecting to CDP...";
      break;
    case "active":
      statusBarItem.text = `$(check) Auto-Confirm: On (${autoClicker?.clickCount ?? 0})`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      statusBarItem.tooltip = "Click to stop LLM Auto-Confirm";
      break;
    case "error":
      statusBarItem.text = "$(error) Auto-Confirm: Error";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      statusBarItem.tooltip =
        "CDP connection failed. Is --remote-debugging-port enabled?";
      break;
  }
  statusBarItem.show();
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

async function startAutoConfirm() {
  if (autoClicker?.isRunning) {
    vscode.window.showInformationMessage("LLM Auto-Confirm is already running.");
    return;
  }

  const { debugPort, autoClickerConfig } = getConfig();
  updateStatusBar("connecting");
  log(`Connecting to CDP on port ${debugPort}...`);

  cdpClient = new CDPClient(debugPort);
  const connected = await cdpClient.connect();

  if (!connected) {
    updateStatusBar("error");
    log("Failed to connect to CDP.");
    const action = await vscode.window.showErrorMessage(
      "Cannot connect to Chrome DevTools Protocol. Make sure your IDE was launched with --remote-debugging-port=9222",
      "Show Setup Guide",
      "Retry"
    );
    if (action === "Show Setup Guide") {
      showSetupGuide();
    } else if (action === "Retry") {
      await startAutoConfirm();
    }
    return;
  }

  log(`CDP connected to ${cdpClient.connectedCount} target(s) (main page + webview iframes).`);

  autoClicker = new AutoClicker(cdpClient, autoClickerConfig);

  autoClicker.onClick = (event) => {
    log(
      `Clicked: "${event.buttonText}" (selector: ${event.selector}) | Total: ${autoClicker!.clickCount}`
    );
    updateStatusBar("active");
  };

  autoClicker.onTargetsChanged = (count) => {
    log(`CDP targets updated: now connected to ${count} target(s).`);
  };

  autoClicker.onError = (error) => {
    log(`Error: ${error}`);
    // AutoClicker already stopped itself - clean up remaining resources
    if (cdpClient) {
      cdpClient.disconnect();
      cdpClient = null;
    }
    autoClicker = null;
    updateStatusBar("error");
  };

  autoClicker.start();
  updateStatusBar("active");
  log(
    `Auto-clicker started (interval: ${autoClickerConfig.pollingInterval}ms)`
  );
  vscode.window.showInformationMessage("LLM Auto-Confirm started.");
}

function stopAutoConfirm() {
  if (autoClicker) {
    const count = autoClicker.clickCount;
    autoClicker.stop();
    autoClicker = null;
    log(`Auto-clicker stopped. Total clicks: ${count}`);
  }
  if (cdpClient) {
    cdpClient.disconnect();
    cdpClient = null;
  }
  updateStatusBar("off");
  vscode.window.showInformationMessage("LLM Auto-Confirm stopped.");
}

function toggleAutoConfirm() {
  if (autoClicker?.isRunning) {
    stopAutoConfirm();
  } else {
    startAutoConfirm();
  }
}

function showSetupGuide() {
  const panel = vscode.window.createWebviewPanel(
    "llmAutoConfirmSetup",
    "LLM Auto-Confirm Setup",
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); }
    code { background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 2px 6px; border-radius: 3px; }
    pre { background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 12px; border-radius: 6px; overflow-x: auto; }
    h2 { border-bottom: 1px solid var(--vscode-panel-border, #444); padding-bottom: 8px; }
  </style>
</head>
<body>
  <h1>LLM Auto-Confirm Setup Guide</h1>

  <h2>Step 1: Enable Remote Debugging Port</h2>
  <p>You need to launch your IDE with the <code>--remote-debugging-port</code> flag.</p>

  <h3>VS Code (Windows)</h3>
  <pre>code --remote-debugging-port=9222</pre>
  <p>Or add to your shortcut target:<br>
  <code>"C:\\...\\Code.exe" --remote-debugging-port=9222</code></p>

  <h3>VS Code (macOS)</h3>
  <pre>/Applications/Visual\\ Studio\\ Code.app/Contents/MacOS/Electron --remote-debugging-port=9222</pre>
  <p>Or create an alias in your shell profile:<br>
  <code>alias code-debug="code --remote-debugging-port=9222"</code></p>

  <h3>Cursor</h3>
  <pre>cursor --remote-debugging-port=9222</pre>

  <h2>Step 2: Start Auto-Confirm</h2>
  <ol>
    <li>Open Command Palette (<code>Ctrl+Shift+P</code> / <code>Cmd+Shift+P</code>)</li>
    <li>Run <code>LLM Auto Confirm: Start</code></li>
    <li>The status bar will show <strong>Auto-Confirm: On</strong> when active</li>
  </ol>

  <h2>Step 3: Customize (Optional)</h2>
  <p>Open Settings and search for <code>llmAutoConfirm</code> to configure:</p>
  <ul>
    <li><strong>Polling interval</strong> - how often to check for buttons (default: 2000ms)</li>
    <li><strong>Button selectors</strong> - CSS selectors for approval buttons</li>
    <li><strong>Text patterns</strong> - button text to match (e.g., "Allow", "Accept")</li>
    <li><strong>Dangerous patterns</strong> - commands that should never be auto-approved</li>
  </ul>

  <h2>Persistent Setup (Windows)</h2>
  <p>To always launch with the debugging port, edit the shortcut properties:</p>
  <pre>Target: "C:\\Users\\...\\Code.exe" --remote-debugging-port=9222</pre>

  <h2>Persistent Setup (macOS / Linux)</h2>
  <p>Add to your <code>~/.bashrc</code> or <code>~/.zshrc</code>:</p>
  <pre>alias code="code --remote-debugging-port=9222"</pre>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("LLM Auto-Confirm");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "llm-auto-confirm.toggle";
  updateStatusBar("off");

  context.subscriptions.push(
    vscode.commands.registerCommand("llm-auto-confirm.start", startAutoConfirm),
    vscode.commands.registerCommand("llm-auto-confirm.stop", stopAutoConfirm),
    vscode.commands.registerCommand(
      "llm-auto-confirm.toggle",
      toggleAutoConfirm
    ),
    statusBarItem,
    outputChannel,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("llmAutoConfirm") && autoClicker?.isRunning) {
        const { autoClickerConfig } = getConfig();
        autoClicker.updateConfig(autoClickerConfig);
        log("Configuration updated.");
      }
    })
  );

  // Auto-start if configured
  const { enabled } = getConfig();
  if (enabled) {
    startAutoConfirm();
  }

  log("Extension activated.");
}

export function deactivate() {
  if (autoClicker) {
    autoClicker.stop();
  }
  if (cdpClient) {
    cdpClient.disconnect();
  }
}
