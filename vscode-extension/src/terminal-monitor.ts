import * as vscode from "vscode";

// --- Prompt Rule types ---

export interface PromptRule {
  name: string;
  pattern: string;
  response: string;
  addNewline: boolean;
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
    .replace(/\r\n/g, "\n") // CRLF → LF
    .replace(/\r/g, "\n"); // Lone CR → LF (preserve line structure from TUI redraws)
}

const MAX_BUFFER = 4000;

// --- Compiled rule ---

interface CompiledRule {
  name: string;
  pattern: RegExp;
  response: string;
  addNewline: boolean;
}

// --- TerminalMonitor ---

export class TerminalMonitor {
  private outputBuffer = "";
  private isActive = true;
  private lastConfirmTime = 0;
  private lastDataTime = 0;
  private _confirmCount = 0;
  private compiledRules: CompiledRule[];
  private compiledFallbackPatterns: RegExp[];
  private compiledDangerPatterns: RegExp[];
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private streamActive = false;

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
      `Main execution stream ended for terminal: ${this.terminal.name} — starting periodic fallback`
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

      // Send the default confirm response to the terminal
      const response = this.config.confirmResponse || "1";
      this.terminal.sendText(response, false);
      this._confirmCount++;
      periodicSendCount++;
      this.lastConfirmTime = Date.now();
      this.debugLog(
        `[periodic] Sent "${response}" to ${this.terminal.name} | periodic=${periodicSendCount}/${maxSends} | Total: ${this._confirmCount}`
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

  private isDangerous(text: string): boolean {
    return this.compiledDangerPatterns.some((p) => p.test(text));
  }

  private confirmWithRule(rule: CompiledRule, promptText: string): void {
    this.terminal.sendText(rule.response, rule.addNewline);
    this._confirmCount++;
    this.lastConfirmTime = Date.now();
    this.outputBuffer = "";
    this.log(
      `Confirmed [${rule.name}] in ${this.terminal.name}: "${promptText}" → sent "${rule.response}" (newline=${rule.addNewline}) | Total: ${this._confirmCount}`
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
    this.outputBuffer = "";
    this.log(
      `Confirmed [fallback] in ${this.terminal.name}: "${promptText}" → sent "${this.config.confirmResponse}" | Total: ${this._confirmCount}`
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
