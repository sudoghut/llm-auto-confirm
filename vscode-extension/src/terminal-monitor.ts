import * as vscode from "vscode";

export interface TerminalMonitorConfig {
  confirmResponse: string;
  cooldown: number;
  promptPatterns: string[];
  dangerousCommandPatterns: string[];
}

export interface ConfirmEvent {
  promptText: string;
  timestamp: Date;
  terminalName: string;
}

/** Strip ANSI escape sequences from terminal output */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // CSI sequences (colors, cursor)
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences (title, etc.)
    .replace(/\x1b\(B/g, "") // Character set selection
    .replace(/\x1b\[\?[0-9;]*[hl]/g, "") // DEC private mode
    .replace(/\r/g, ""); // Carriage returns
}

const MAX_BUFFER = 2000;

export class TerminalMonitor {
  private outputBuffer = "";
  private isActive = true;
  private lastConfirmTime = 0;
  private _confirmCount = 0;
  private compiledPromptPatterns: RegExp[];
  private compiledDangerPatterns: RegExp[];

  public onConfirm: ((event: ConfirmEvent) => void) | null = null;
  public onDangerousBlocked: ((promptText: string) => void) | null = null;
  public onError: ((error: string) => void) | null = null;

  constructor(
    private terminal: vscode.Terminal,
    private execution: vscode.TerminalShellExecution,
    private config: TerminalMonitorConfig,
    private log: (msg: string) => void
  ) {
    this.compiledPromptPatterns = config.promptPatterns.map(
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
    try {
      for await (const data of this.execution.read()) {
        if (!this.isActive) break;
        this.appendAndTrim(data);
        this.checkForPrompt();
      }
    } catch (err) {
      if (this.isActive) {
        this.onError?.(`Stream error: ${err}`);
      }
    }
    this.log(`Monitor ended for terminal: ${this.terminal.name}`);
  }

  stop(): void {
    this.isActive = false;
  }

  updateConfig(config: TerminalMonitorConfig): void {
    this.config = config;
    this.compiledPromptPatterns = config.promptPatterns.map(
      (p) => new RegExp(p, "is")
    );
    this.compiledDangerPatterns = config.dangerousCommandPatterns.map(
      (p) => new RegExp(p, "i")
    );
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
    const recentText = this.getRecentLines(20);
    const matchedPrompt = this.isPermissionPrompt(recentText);
    if (matchedPrompt === null) {
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
    this.confirm(matchedPrompt);
  }

  private isPermissionPrompt(text: string): string | null {
    for (const pattern of this.compiledPromptPatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0].substring(0, 100);
      }
    }
    return null;
  }

  private isDangerous(text: string): boolean {
    return this.compiledDangerPatterns.some((p) => p.test(text));
  }

  private confirm(promptText: string): void {
    this.terminal.sendText(this.config.confirmResponse, true);
    this._confirmCount++;
    this.lastConfirmTime = Date.now();
    this.outputBuffer = "";
    this.log(
      `Confirmed prompt in ${this.terminal.name}: "${promptText}" | Total: ${this._confirmCount}`
    );
    this.onConfirm?.({
      promptText,
      timestamp: new Date(),
      terminalName: this.terminal.name,
    });
  }

  private getRecentLines(n: number): string {
    const lines = this.outputBuffer.split("\n");
    return lines.slice(-n).join("\n");
  }
}
