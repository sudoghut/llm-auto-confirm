import * as vscode from "vscode";

// --- Prompt Rule types ---

/** Controls newline behavior: true/false are static; "auto" detects interactive lists. */
export type AddNewlineMode = boolean | "auto";

export interface PromptRule {
  name: string;
  pattern: string;
  response: string;
  addNewline: AddNewlineMode;
}

export interface TerminalMonitorConfig {
  confirmResponse: string;
  cooldown: number;
  promptPatterns: string[];
  promptRules: PromptRule[];
  dangerousCommandPatterns: string[];
  /** Enable periodic fallback when the output stream ends. Default: false. */
  periodicFallback: boolean;
  /** Max number of periodic fallback sends before stopping. Default: 10. */
  periodicFallbackMaxSends: number;
  /** Whether periodic fallback should press Enter after response. Default: true. */
  periodicFallbackAddNewline: boolean;
}

export interface ConfirmEvent {
  promptText: string;
  ruleName: string;
  timestamp: Date;
  terminalName: string;
}

// --- ANSI stripping ---

/** Strip ANSI escape sequences from terminal output */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // CSI sequences (colors, cursor, clear)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (title, etc.)
    .replace(/\x1b\([A-Za-z]/g, "") // Character set selection
    .replace(/\x1b\[\?[0-9;]*[hl]/g, "") // DEC private mode set/reset
    .replace(/\x1b[=>]/g, "") // Keypad modes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // Control chars (keep \n \t \r)
    .replace(/\r\n/g, "\n") // CRLF -> LF
    .replace(/\r/g, "\n"); // Lone CR -> LF (preserve line structure from TUI redraws)
}

const MAX_BUFFER = 4000;

// --- Compiled rule ---

interface CompiledRule {
  name: string;
  pattern: RegExp;
  response: string;
  addNewline: AddNewlineMode;
}

// --- TerminalMonitor ---

export class TerminalMonitor {
  private static readonly BUFFER_KEEP_LINES_AFTER_CONFIRM = 20;
  private static readonly PROMPT_SIGNAL_WINDOW_MS = 15000;
  private static readonly DUPLICATE_CONFIRM_WINDOW_MS = 2500;

  private outputBuffer = "";
  private isActive = true;
  private lastConfirmTime = 0;
  private lastDataTime = 0;
  private lastPromptSignalTime = 0;
  private _confirmCount = 0;
  private compiledRules: CompiledRule[];
  private compiledFallbackPatterns: RegExp[];
  private compiledDangerPatterns: RegExp[];
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private streamActive = false;
  private recentConfirmSignatures = new Map<string, number>();

  public onConfirm: ((event: ConfirmEvent) => void) | null = null;
  public onDangerousBlocked: ((promptText: string) => void) | null = null;
  public onError: ((error: string) => void) | null = null;

  constructor(
    private terminal: vscode.Terminal,
    private execution: vscode.TerminalShellExecution,
    private config: TerminalMonitorConfig,
    private log: (msg: string) => void,
    private debugLog: (msg: string) => void = log
  ) {
    this.compiledRules = this.compileRules(config.promptRules);
    this.compiledFallbackPatterns = config.promptPatterns.map(
      (p) => new RegExp(p, "is")
    );
    this.compiledDangerPatterns = config.dangerousCommandPatterns.map(
      (p) => new RegExp(p, "i")
    );
  }

  get confirmCount(): number {
    return this._confirmCount;
  }

  async start(): Promise<void> {
    this.log(
      `Monitoring terminal: ${this.terminal.name} | command: ${this.execution.commandLine.value}`
    );
    this.log(
      `Loaded ${this.compiledRules.length} prompt rules, ${this.compiledFallbackPatterns.length} fallback patterns`
    );
    this.streamActive = true;
    await this.readExecution(this.execution, "main");
    this.streamActive = false;
    this.log(
      `Main execution stream ended for terminal: ${this.terminal.name} - starting periodic fallback`
    );
    this.startPeriodicFallback();
  }

  /**
   * Attach a sub-execution's output stream to this monitor.
   * Called when a new command starts in a terminal that already has a monitor.
   * This captures output between commands (e.g., permission prompts from Claude).
   */
  async attachExecution(
    execution: vscode.TerminalShellExecution
  ): Promise<void> {
    const cmd = execution.commandLine.value.substring(0, 80);
    this.log(`Attached sub-execution: "${cmd}"`);
    this.streamActive = true;
    await this.readExecution(execution, "sub");
    this.streamActive = false;
    this.log(`Sub-execution ended: "${cmd}"`);
  }

  private async readExecution(
    execution: vscode.TerminalShellExecution,
    label: string
  ): Promise<void> {
    try {
      for await (const data of execution.read()) {
        if (!this.isActive) break;
        this.lastDataTime = Date.now();
        if (data.length > 0) {
          const preview = data.substring(0, 200).replace(/\n/g, "\\n");
          this.debugLog(`[raw:${label}] ${preview}${data.length > 200 ? "..." : ""}`);
        }
        this.appendAndTrim(data);
        this.checkForPrompt();
      }
    } catch (err) {
      if (this.isActive) {
        this.onError?.(`Stream error (${label}): ${err}`);
      }
    }
  }

  stop(): void {
    this.isActive = false;
    this.stopPeriodicFallback();
  }

  /**
   * When execution.read() stops yielding data (common with interactive TUI programs),
   * optionally fall back to periodically sending the confirm keystroke.
   *
   * Disabled by default (config.periodicFallback = false) because it sends
   * without prompt detection or dangerous-command checks.  Enable only if
   * your LLM tool stops producing readable output while still prompting.
   */
  private startPeriodicFallback(): void {
    if (this.fallbackTimer || !this.isActive) return;

    // Opt-in only
    if (!this.config.periodicFallback) {
      this.log(
        `[periodic] Fallback disabled for ${this.terminal.name} (set periodicFallback=true to enable)`
      );
      return;
    }

    const maxSends = this.config.periodicFallbackMaxSends || 10;
    let periodicSendCount = 0;
    const interval = Math.max(this.config.cooldown * 2, 2000);
    this.log(
      `[periodic] Fallback active for ${this.terminal.name}, interval=${interval}ms, max=${maxSends}`
    );
    this.fallbackTimer = setInterval(() => {
      if (!this.isActive || periodicSendCount >= maxSends) {
        this.stopPeriodicFallback();
        return;
      }
      // If a sub-execution stream is active, let it handle detection instead
      if (this.streamActive) return;
      // Respect cooldown
      if (Date.now() - this.lastConfirmTime < this.config.cooldown) return;
      // Only send if terminal had output recently (within 30s)
      if (Date.now() - this.lastDataTime > 30000) return;
      // Only send if we saw approval-like text recently (avoid blind sends)
      if (
        Date.now() - this.lastPromptSignalTime >
        TerminalMonitor.PROMPT_SIGNAL_WINDOW_MS
      ) {
        return;
      }

      // Send the default confirm response to the terminal
      const response = this.config.confirmResponse || "1";
      this.terminal.sendText(response, this.config.periodicFallbackAddNewline);
      this._confirmCount++;
      periodicSendCount++;
      this.lastConfirmTime = Date.now();
      this.debugLog(
        `[periodic] Sent "${response}" (newline=${this.config.periodicFallbackAddNewline}) to ${this.terminal.name} | periodic=${periodicSendCount}/${maxSends} | Total: ${this._confirmCount}`
      );
      this.onConfirm?.({
        promptText: "(periodic fallback)",
        ruleName: "periodic",
        timestamp: new Date(),
        terminalName: this.terminal.name,
      });
    }, interval);
  }

  private stopPeriodicFallback(): void {
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
      this.log(`[periodic] Fallback stopped for ${this.terminal.name}`);
    }
  }

  updateConfig(config: TerminalMonitorConfig): void {
    this.config = config;
    this.compiledRules = this.compileRules(config.promptRules);
    this.compiledFallbackPatterns = config.promptPatterns.map(
      (p) => new RegExp(p, "is")
    );
    this.compiledDangerPatterns = config.dangerousCommandPatterns.map(
      (p) => new RegExp(p, "i")
    );
  }

  private compileRules(rules: PromptRule[]): CompiledRule[] {
    const compiled: CompiledRule[] = [];
    for (const rule of rules) {
      try {
        compiled.push({
          name: rule.name,
          pattern: new RegExp(rule.pattern, "is"),
          response: rule.response,
          addNewline: rule.addNewline,
        });
      } catch (err) {
        this.log(`Invalid regex in rule "${rule.name}": ${err}`);
      }
    }
    return compiled;
  }

  private appendAndTrim(data: string): void {
    const clean = stripAnsi(data);
    this.outputBuffer += clean;
    if (this.outputBuffer.length > MAX_BUFFER) {
      this.outputBuffer = this.outputBuffer.slice(-MAX_BUFFER);
    }
  }

  private checkForPrompt(): void {
    if (Date.now() - this.lastConfirmTime < this.config.cooldown) {
      return;
    }
    const recentText = this.getRecentLines(30);
    if (this.looksLikeApprovalPrompt(recentText)) {
      this.lastPromptSignalTime = Date.now();
      this.debugLog(
        `[hint] Approval-like text seen in ${this.terminal.name}: "${this.trimForLog(recentText)}"`
      );
    }

    // Try prompt rules first (each rule has its own response)
    const matchedRule = this.matchRule(recentText);
    if (matchedRule) {
      this.lastPromptSignalTime = Date.now();
      const signature = `rule:${matchedRule.rule.name}:${this.normalizePromptText(matchedRule.matchText)}`;
      if (this.isDuplicateConfirm(signature)) {
        this.debugLog(
          `[dedupe] Skipped duplicate rule confirm in ${this.terminal.name}: ${matchedRule.rule.name}`
        );
        return;
      }
      if (this.isDangerous(recentText)) {
        this.log(
          `BLOCKED dangerous command in ${this.terminal.name}: ${recentText.substring(0, 100)}`
        );
        this.onDangerousBlocked?.(recentText.substring(0, 100));
        this.outputBuffer = "";
        return;
      }
      this.confirmWithRule(matchedRule.rule, matchedRule.matchText);
      return;
    }

    // Fallback: old-style promptPatterns + global confirmResponse
    const matchedFallback = this.matchFallbackPattern(recentText);
    if (matchedFallback) {
      this.lastPromptSignalTime = Date.now();
      const signature = `fallback:${this.normalizePromptText(matchedFallback)}`;
      if (this.isDuplicateConfirm(signature)) {
        this.debugLog(
          `[dedupe] Skipped duplicate fallback confirm in ${this.terminal.name}`
        );
        return;
      }
      if (this.isDangerous(recentText)) {
        this.log(
          `BLOCKED dangerous command in ${this.terminal.name}: ${recentText.substring(0, 100)}`
        );
        this.onDangerousBlocked?.(recentText.substring(0, 100));
        this.outputBuffer = "";
        return;
      }
      this.confirmWithFallback(matchedFallback);
    }
  }

  private matchRule(
    text: string
  ): { rule: CompiledRule; matchText: string } | null {
    for (const rule of this.compiledRules) {
      const match = text.match(rule.pattern);
      if (match) {
        this.debugLog(`[match] Rule "${rule.name}" matched: "${match[0].substring(0, 80)}"`);
        return { rule, matchText: match[0].substring(0, 100) };
      }
    }
    return null;
  }

  private matchFallbackPattern(text: string): string | null {
    for (const pattern of this.compiledFallbackPatterns) {
      const match = text.match(pattern);
      if (match) {
        this.debugLog(
          `[match] Fallback pattern matched: "${match[0].substring(0, 80)}"`
        );
        return match[0].substring(0, 100);
      }
    }
    return null;
  }

  /**
   * Detect whether recent terminal output contains an interactive list prompt.
   * Interactive lists use cursor markers (U+276F / U+203A / >).
   */
  private detectInteractiveList(): boolean {
    const recentText = this.getRecentLines(15);
    return /(?:\u276f|\u203a|>)\s*\d/.test(recentText);
  }

  private isDangerous(text: string): boolean {
    return this.compiledDangerPatterns.some((p) => p.test(text));
  }

  private looksLikeApprovalPrompt(text: string): boolean {
    return /(?:allow|approve|do you want|save file to continue|proceed\?|yes\s*\/\s*no|\b1\s*\.?\s*yes\b|\b2\s*\.?\s*no\b|(?:\u276f|\u203a|>)\s*\d)/i.test(
      text
    );
  }

  private normalizePromptText(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
  }

  private isDuplicateConfirm(signature: string): boolean {
    const now = Date.now();
    for (const [key, ts] of this.recentConfirmSignatures) {
      if (now - ts > TerminalMonitor.DUPLICATE_CONFIRM_WINDOW_MS) {
        this.recentConfirmSignatures.delete(key);
      }
    }
    const last = this.recentConfirmSignatures.get(signature);
    if (last && now - last <= TerminalMonitor.DUPLICATE_CONFIRM_WINDOW_MS) {
      return true;
    }
    this.recentConfirmSignatures.set(signature, now);
    return false;
  }

  private keepRecentBufferLines(linesToKeep: number): void {
    const lines = this.outputBuffer.split("\n");
    this.outputBuffer = lines.slice(-linesToKeep).join("\n");
  }

  private trimForLog(text: string): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length > 160
      ? `${singleLine.slice(0, 160)}...`
      : singleLine;
  }

  private confirmWithRule(rule: CompiledRule, promptText: string): void {
    let actualResponse: string;
    let actualNewline: boolean;
    let detectionNote = "";

    if (rule.addNewline === "auto") {
      const isInteractive = this.detectInteractiveList();
      if (isInteractive) {
        // Interactive list: just press Enter to select the highlighted item
        actualResponse = "";
        actualNewline = true;
        detectionNote = " [auto: interactive list -> Enter only]";
      } else {
        // Non-interactive: send the response text followed by Enter
        actualResponse = rule.response;
        actualNewline = true;
        detectionNote = " [auto: non-interactive -> response + Enter]";
      }
    } else {
      actualResponse = rule.response;
      actualNewline = rule.addNewline;
    }

    this.terminal.sendText(actualResponse, actualNewline);
    this._confirmCount++;
    this.lastConfirmTime = Date.now();
    this.keepRecentBufferLines(TerminalMonitor.BUFFER_KEEP_LINES_AFTER_CONFIRM);
    this.log(
      `Confirmed [${rule.name}] in ${this.terminal.name}: "${promptText}" -> sent "${actualResponse}" (newline=${actualNewline})${detectionNote} | Total: ${this._confirmCount}`
    );
    this.onConfirm?.({
      promptText,
      ruleName: rule.name,
      timestamp: new Date(),
      terminalName: this.terminal.name,
    });
  }

  private confirmWithFallback(promptText: string): void {
    this.terminal.sendText(this.config.confirmResponse, true);
    this._confirmCount++;
    this.lastConfirmTime = Date.now();
    this.keepRecentBufferLines(TerminalMonitor.BUFFER_KEEP_LINES_AFTER_CONFIRM);
    this.log(
      `Confirmed [fallback] in ${this.terminal.name}: "${promptText}" -> sent "${this.config.confirmResponse}" | Total: ${this._confirmCount}`
    );
    this.onConfirm?.({
      promptText,
      ruleName: "fallback",
      timestamp: new Date(),
      terminalName: this.terminal.name,
    });
  }

  private getRecentLines(n: number): string {
    const lines = this.outputBuffer.split("\n");
    return lines.slice(-n).join("\n");
  }
}
