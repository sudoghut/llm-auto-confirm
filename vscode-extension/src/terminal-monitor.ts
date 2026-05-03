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
}

export interface ConfirmEvent {
  promptText: string;
  ruleName: string;
  timestamp: Date;
  terminalName: string;
}

export interface SuppressedEvent {
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
  /** Hard cooldown after a confirm: ignore ALL pattern checks during this window.
   *  Claude Code's TUI redraws the prompt for several seconds after Enter is sent. */
  private static readonly POST_CONFIRM_COOLDOWN_MS = 8000;
  /** Safety-net periodic re-scan of the buffer. Catches prompts that arrive when
   *  VS Code's shell integration stops yielding data on the main execution stream
   *  (e.g., after sub-executions end, or for Claude Code's internal bash tool). */
  private static readonly PERIODIC_RESCAN_MS = 3000;
  /** If no [raw:*] chunk arrives for this long while a buffer exists, log a stall
   *  marker. Helps distinguish "stream silent" (no data delivered) from "buffer
   *  truncated" (data arrived but evicted). */
  private static readonly STALL_THRESHOLD_MS = 9000;

  private outputBuffer = "";
  private isActive = true;
  private lastConfirmTime = 0;
  private lastDataAt = Date.now();
  private stallReported = false;
  private _confirmCount = 0;
  private compiledRules: CompiledRule[];
  private compiledFallbackPatterns: RegExp[];
  private compiledDangerPatterns: RegExp[];
  /** Timer that fires once after post-confirm cooldown to re-check the buffer. */
  private postConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Periodic buffer re-scan as a safety net against silent streams. */
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  /** Total bytes received via execution.read() - for diagnostics. */
  private totalBytesRead = 0;
  private totalChunksRead = 0;
  private readonly shouldConfirm: () => boolean;

  public onConfirm: ((event: ConfirmEvent) => void) | null = null;
  public onSuppressed: ((event: SuppressedEvent) => void) | null = null;
  public onDangerousBlocked: ((promptText: string) => void) | null = null;
  public onError: ((error: string) => void) | null = null;

  constructor(
    private terminal: vscode.Terminal,
    private execution: vscode.TerminalShellExecution,
    private config: TerminalMonitorConfig,
    shouldConfirm: () => boolean,
    private log: (msg: string) => void,
    private debugLog: (msg: string) => void = log
  ) {
    this.shouldConfirm = shouldConfirm;
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
    this.startPeriodicRescan();
    await this.readExecution(this.execution, "main");
    this.log(
      `Main stream ended for ${this.terminal.name} | total: ${this.totalChunksRead} chunks, ${this.totalBytesRead} bytes`
    );
  }

  private startPeriodicRescan(): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      if (!this.isActive) return;
      if (this.outputBuffer.length === 0) return;
      const sinceData = Date.now() - this.lastDataAt;
      if (sinceData > TerminalMonitor.STALL_THRESHOLD_MS && !this.stallReported) {
        this.debugLog(
          `[stall] No new [raw] data for ${(sinceData / 1000).toFixed(1)}s, buffer frozen at ${this.outputBuffer.length} chars`
        );
        this.stallReported = true;
      }
      this.debugLog(`[periodic] Re-scanning buffer (${this.outputBuffer.length} chars)`);
      this.checkForPrompt();
    }, TerminalMonitor.PERIODIC_RESCAN_MS);
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
    const prevBytes = this.totalBytesRead;
    await this.readExecution(execution, "sub");
    const bytesThisSub = this.totalBytesRead - prevBytes;
    this.log(`Sub-execution ended: "${cmd}" | read ${bytesThisSub} bytes`);
  }

  private async readExecution(
    execution: vscode.TerminalShellExecution,
    label: string
  ): Promise<void> {
    try {
      for await (const data of execution.read()) {
        if (!this.isActive) break;
        this.totalBytesRead += data.length;
        this.totalChunksRead++;
        this.lastDataAt = Date.now();
        this.stallReported = false;
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
    if (this.postConfirmTimer) {
      clearTimeout(this.postConfirmTimer);
      this.postConfirmTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    this.log(
      `Monitor stopped for ${this.terminal.name} | total: ${this.totalChunksRead} chunks, ${this.totalBytesRead} bytes, ${this._confirmCount} confirms`
    );
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

  /**
   * Schedule a one-shot buffer check after the post-confirm cooldown expires.
   * This catches prompts whose text arrived during the cooldown but whose
   * TUI animation stopped before the cooldown ended (so no new data triggers checkForPrompt).
   */
  private schedulePostConfirmCheck(): void {
    if (this.postConfirmTimer) {
      clearTimeout(this.postConfirmTimer);
    }
    this.postConfirmTimer = setTimeout(() => {
      this.postConfirmTimer = null;
      if (!this.isActive) return;
      this.debugLog(`[post-confirm] Cooldown expired, re-checking buffer (${this.outputBuffer.length} chars)`);
      this.checkForPrompt();
    }, TerminalMonitor.POST_CONFIRM_COOLDOWN_MS + 200); // +200ms margin
  }

  private checkForPrompt(): void {
    const sinceLastConfirm = Date.now() - this.lastConfirmTime;
    const effectiveCooldown = Math.max(
      this.config.cooldown,
      TerminalMonitor.POST_CONFIRM_COOLDOWN_MS
    );
    if (sinceLastConfirm < effectiveCooldown) {
      return;
    }
    const recentText = this.getRecentLines(30);

    // Try prompt rules first (each rule has its own response)
    const matchedRule = this.matchRule(recentText);
    if (matchedRule) {
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

  private trimForLog(text: string): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length > 160
      ? `${singleLine.slice(0, 160)}...`
      : singleLine;
  }

  private suppressMatch(promptText: string, ruleName: string): boolean {
    if (this.shouldConfirm()) {
      return false;
    }

    this.log(
      `Matched [${ruleName}] in ${this.terminal.name} but suppressed in observe-only mode: "${promptText}"`
    );
    this.onSuppressed?.({
      promptText,
      ruleName,
      timestamp: new Date(),
      terminalName: this.terminal.name,
    });
    return true;
  }

  private confirmWithRule(rule: CompiledRule, promptText: string): void {
    let actualResponse: string;
    let actualNewline: boolean;
    let detectionNote = "";

    if (rule.addNewline === "auto") {
      const isInteractive = this.detectInteractiveList();
      if (isInteractive) {
        actualResponse = "";
        actualNewline = true;
        detectionNote = " [auto: interactive list -> Enter only]";
      } else {
        actualResponse = rule.response;
        actualNewline = true;
        detectionNote = " [auto: non-interactive -> response + Enter]";
      }
    } else {
      actualResponse = rule.response;
      actualNewline = rule.addNewline;
    }

    if (this.suppressMatch(promptText, rule.name)) {
      return;
    } 

    this.terminal.sendText(actualResponse, actualNewline);
    this._confirmCount++;
    this.lastConfirmTime = Date.now();
    this.outputBuffer = "";
    this.schedulePostConfirmCheck();
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
    if (this.suppressMatch(promptText, "fallback")) {
      return;
    }

    this.terminal.sendText(this.config.confirmResponse, true);
    this._confirmCount++;
    this.lastConfirmTime = Date.now();
    this.outputBuffer = "";
    this.schedulePostConfirmCheck();
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
