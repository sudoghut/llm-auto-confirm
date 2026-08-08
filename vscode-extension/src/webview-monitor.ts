import * as vscode from "vscode";

/**
 * Known LLM extension approval commands -- verified against real extensions.
 *
 * IMPORTANT: Most webview-based LLM extensions handle permission prompts
 * INSIDE their webview and do NOT expose per-prompt approval commands.
 * The commands below are the best available options:
 *
 * - `acceptProposedDiff`: accepts editor diff proposals (not webview permission prompts)
 * - `acceptInput`: accepts pending input in the chat panel
 * - `toggleAutoApprove`: toggles the extension's own auto-approve mode (one-shot)
 *
 * For extensions without approval commands (Codex, etc.), use the terminal
 * CLI mode instead, where the terminal monitor can detect and confirm prompts.
 */
const BUILTIN_APPROVAL_COMMANDS: ApprovalCommandEntry[] = [
  // --- Kilo Code ---
  //   toggleAutoApprove enables auto-approve mode within the extension.
  //   We only need to call it once (handled by oneShot flag).
  { name: "Kilo Code (auto-approve)", command: "kilo-code.toggleAutoApprove", oneShot: true, tabPattern: /\bkilo\s*code\b/i },
  { name: "Kilo Code (accept input)", command: "kilo-code.acceptInput", oneShot: false, tabPattern: /\bkilo\s*code\b/i },

  // --- Claude Code (Anthropic) ---
  //   acceptProposedDiff accepts a diff shown in the editor.
  //   NOTE: This does NOT approve webview tool-use permission prompts.
  //   For terminal-based Claude Code, use the terminal monitor instead.
  { name: "Claude Code (accept diff)", command: "claude-vscode.acceptProposedDiff", oneShot: false, tabPattern: /\bclaude\b/i },
  { name: "Claude Code (accept diff alt)", command: "claude-code.acceptProposedDiff", oneShot: false, tabPattern: /\bclaude\b/i },

  // --- Cline / Roo Code (if installed) ---
  { name: "Cline", command: "cline.approveTask", oneShot: false, tabPattern: /\bcline\b/i },
  { name: "Roo Code", command: "roo-cline.approveTask", oneShot: false, tabPattern: /\broo\s*code\b/i },
];

/**
 * Allowlist of command ID prefixes that are permitted for execution.
 * User-configured commands must start with one of these prefixes.
 * This prevents a malicious .vscode/settings.json from executing
 * arbitrary VS Code commands (e.g., "workbench.action.terminal.sendSequence").
 */
const ALLOWED_COMMAND_PREFIXES = [
  "kilo-code.",
  "claude-vscode.",
  "claude-code.",
  "claude-dev.",
  "cline.",
  "roo-cline.",
  "roo-code.",
];

export interface ApprovalCommandEntry {
  name: string;
  command: string;
  /** If true, only execute once (e.g., toggle auto-approve mode). */
  oneShot?: boolean;
  /** Tab label pattern to match before executing this command.
   *  Only executes when a webview tab matching this pattern is visible.
   *  Built-in commands have this set; user-configured commands without it
   *  fall back to the generic "any LLM webview visible" check. */
  tabPattern?: RegExp;
}

export interface WebviewMonitorConfig {
  pollInterval: number;
  approvalCommands: ApprovalCommandEntry[];
  cooldown: number;
}

/**
 * Monitors for WebView-based LLM extensions by periodically executing
 * known approval commands via the VS Code command API.
 *
 * This replaces the previous OS-level keystroke simulation approach.
 * Benefits:
 * - No command-injection risk (no shell execution)
 * - Targets the exact extension, not "whatever is focused"
 * - Works when VS Code is minimized / unfocused
 * - No interference with editor, terminal, or other input areas
 *
 * Security:
 * - User-configured commands are validated against an allowlist of known
 *   LLM extension prefixes to prevent workspace config injection attacks.
 * - Built-in commands are trusted and skip the allowlist check.
 *
 * Limitations:
 * - Most extensions handle permission prompts inside their webview
 *   and don't expose per-prompt approval commands from outside.
 * - For unsupported extensions, use their CLI/terminal mode instead.
 *
 * Supported extensions:
 * - Kilo Code: toggleAutoApprove (one-shot) + acceptInput
 * - Claude Code: acceptProposedDiff (editor diffs only, NOT webview prompts)
 * - Cline / Roo Code: approveTask (if command is registered)
 * - NOT supported: Codex (no approval commands exposed)
 */
export class WebviewMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSendTime = 0;
  private _sendCount = 0;
  private running = false;
  private stopped = false;

  /** All commands that are actually registered in the current session. */
  private resolvedCommands: ApprovalCommandEntry[] = [];
  /** Track one-shot commands that have already been executed. */
  private executedOneShots = new Set<string>();

  public onCommandExecuted: ((entry: ApprovalCommandEntry) => void) | null =
    null;

  constructor(
    private config: WebviewMonitorConfig,
    private shouldExecute: () => boolean,
    private log: (msg: string) => void,
    private debugLog: (msg: string) => void = log
  ) {}

  get sendCount(): number {
    return this._sendCount;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.log(
      `[webview] Starting command-based monitor: poll=${this.config.pollInterval}ms`
    );

    // Validate user-configured commands against the allowlist
    const validated = this.validateUserCommands(this.config.approvalCommands);

    await this.discoverCommands(validated);

    // Guard: if stop() was called while we were discovering, bail out
    if (this.stopped) {
      this.log("[webview] Monitor was stopped during startup, aborting.");
      return;
    }

    if (this.resolvedCommands.length === 0) {
      this.log(
        "[webview] No known approval commands found in current session. " +
          "Monitor will re-check periodically in case extensions load later."
      );
    } else {
      this.log(
        `[webview] Found ${this.resolvedCommands.length} approval command(s): ${this.resolvedCommands.map((c) => c.command).join(", ")}`
      );
    }

    this.timer = setInterval(() => this.tick(), this.config.pollInterval);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log(
      `[webview] Monitor stopped. Total commands executed: ${this._sendCount}`
    );
  }

  updateConfig(config: WebviewMonitorConfig): void {
    const needRestart = config.pollInterval !== this.config.pollInterval;
    this.config = config;
    // Re-discover in case user changed the command list
    this.resolvedCommands = [];
    this.executedOneShots.clear();
    if (needRestart && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), this.config.pollInterval);
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Validate user-configured commands against the allowlist.
   * Rejects commands that don't match any known LLM extension prefix.
   */
  private validateUserCommands(
    commands: ApprovalCommandEntry[]
  ): ApprovalCommandEntry[] {
    const valid: ApprovalCommandEntry[] = [];
    for (const entry of commands) {
      const allowed = ALLOWED_COMMAND_PREFIXES.some((prefix) =>
        entry.command.startsWith(prefix)
      );
      if (allowed) {
        valid.push(entry);
      } else {
        this.log(
          `[webview] REJECTED user command "${entry.command}" -- ` +
            `does not match any allowed prefix (${ALLOWED_COMMAND_PREFIXES.join(", ")}). ` +
            `This prevents potential workspace config injection.`
        );
      }
    }
    return valid;
  }

  /**
   * Scan VS Code's registered commands for ALL matches in our
   * approval-command list (validated user commands + built-in).
   */
  private async discoverCommands(
    validatedUserCommands: ApprovalCommandEntry[]
  ): Promise<void> {
    const allCommands = await vscode.commands.getCommands(true);
    const commandSet = new Set(allCommands);

    const candidates = [
      ...validatedUserCommands,
      ...BUILTIN_APPROVAL_COMMANDS,
    ];

    this.resolvedCommands = candidates.filter((entry) =>
      commandSet.has(entry.command)
    );
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.doTick();
    } finally {
      this.running = false;
    }
  }

  private async doTick(): Promise<void> {
    const now = Date.now();

    if (!this.shouldExecute()) {
      this.debugLog("[webview] Observe-only mode: skipping approval commands.");
      return;
    }

    // Cooldown
    if (now - this.lastSendTime < this.config.cooldown) return;

    // Re-discover periodically if we have no commands
    if (this.resolvedCommands.length === 0) {
      const validated = this.validateUserCommands(
        this.config.approvalCommands
      );
      await this.discoverCommands(validated);
      if (this.resolvedCommands.length === 0) return;
    }

    // Only execute one-shot commands unconditionally.
    // For repeating commands, check that the specific extension's webview is
    // visible. Each built-in command has a tabPattern binding its execution
    // to the correct extension's webview tab.
    const visibleLabels = this.getVisibleWebviewLabels();

    for (const entry of this.resolvedCommands) {
      if (this.stopped) return;

      // Skip one-shot commands that were already executed
      if (entry.oneShot && this.executedOneShots.has(entry.command)) {
        continue;
      }

      // For non-oneShot commands, check that the matching webview is visible
      if (!entry.oneShot) {
        if (entry.tabPattern) {
          // Built-in: require the specific extension's webview
          if (!visibleLabels.some((label) => entry.tabPattern!.test(label))) {
            continue;
          }
        } else {
          // User-configured without tabPattern: require any LLM webview
          if (!visibleLabels.some((label) => this.isLLMLabel(label))) {
            continue;
          }
        }
      }

      try {
        await vscode.commands.executeCommand(entry.command);
        this._sendCount++;
        this.lastSendTime = Date.now();

        if (entry.oneShot) {
          this.executedOneShots.add(entry.command);
          this.log(
            `[webview] Executed one-shot "${entry.name}" (${entry.command}) -- will not repeat`
          );
        } else {
          this.debugLog(
            `[webview] Executed "${entry.name}" (${entry.command}) | Total: ${this._sendCount}`
          );
        }

        this.onCommandExecuted?.(entry);
      } catch (err) {
        this.log(
          `[webview] Command "${entry.command}" failed: ${err}. Removing from active list.`
        );
        this.resolvedCommands = this.resolvedCommands.filter(
          (c) => c.command !== entry.command
        );
      }
    }
  }

  /** Known LLM extension tab label patterns (fallback for user commands without tabPattern). */
  private static readonly LLM_TAB_PATTERNS = [
    /\bclaude\b/i,
    /\bkilo\s*code\b/i,
    /\bcline\b/i,
    /\broo\s*code\b/i,
    /\bcodex\b/i,
  ];

  /** Collect labels of all visible webview tabs. */
  private getVisibleWebviewLabels(): string[] {
    const labels: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputWebview) {
          labels.push(tab.label);
        }
      }
    }
    return labels;
  }

  /** Check if a tab label matches any known LLM extension. */
  private isLLMLabel(label: string): boolean {
    return WebviewMonitor.LLM_TAB_PATTERNS.some((p) => p.test(label));
  }
}
