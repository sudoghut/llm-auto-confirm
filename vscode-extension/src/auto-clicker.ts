import { CDPClient } from "./cdp-client";

export interface AutoClickerConfig {
  pollingInterval: number;
  buttonSelectors: string[];
  buttonTextPatterns: string[];
  dangerousCommandPatterns: string[];
}

export interface ClickEvent {
  buttonText: string;
  selector: string;
  timestamp: Date;
}

/**
 * Polls the IDE DOM via CDP for confirmation buttons and clicks them.
 * Scans ALL connected targets (main page + webview iframes).
 */
export class AutoClicker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _clickCount = 0;
  private _onClick: ((event: ClickEvent) => void) | null = null;
  private _onError: ((error: string) => void) | null = null;
  private _onTargetsChanged: ((count: number) => void) | null = null;

  constructor(
    private cdp: CDPClient,
    private config: AutoClickerConfig
  ) {}

  get clickCount(): number {
    return this._clickCount;
  }

  set onClick(handler: (event: ClickEvent) => void) {
    this._onClick = handler;
  }

  set onError(handler: (error: string) => void) {
    this._onError = handler;
  }

  set onTargetsChanged(handler: (count: number) => void) {
    this._onTargetsChanged = handler;
  }

  /** Build the JavaScript that runs inside each target to find and click buttons. */
  private buildScanScript(): string {
    const selectors = JSON.stringify(this.config.buttonSelectors);
    const textPatterns = JSON.stringify(
      this.config.buttonTextPatterns.map((p) => p.toLowerCase())
    );
    const dangerousPatterns = JSON.stringify(
      this.config.dangerousCommandPatterns
    );

    return `
      (function() {
        const selectors = ${selectors};
        const textPatterns = ${textPatterns};
        const dangerousPatterns = ${dangerousPatterns}.map(p => new RegExp(p, 'i'));

        function containsDangerousCommand(el) {
          let container = el;
          for (let i = 0; i < 10 && container.parentElement; i++) {
            container = container.parentElement;
          }
          const text = container.innerText || '';
          return dangerousPatterns.some(p => p.test(text));
        }

        function matchesText(el) {
          const text = (el.textContent || el.title || el.ariaLabel || '').trim().toLowerCase();
          if (!text) return false;
          return textPatterns.some(p => text.includes(p));
        }

        function scanDoc(doc) {
          if (!doc) return null;

          // Try CSS selectors
          for (const sel of selectors) {
            try {
              const buttons = doc.querySelectorAll(sel);
              for (const btn of buttons) {
                if (btn.offsetParent === null) continue;
                if (containsDangerousCommand(btn)) continue;
                btn.click();
                return { clicked: true, text: (btn.textContent || '').trim().substring(0, 50), selector: sel };
              }
            } catch(e) {}
          }

          // Fallback: scan by text content
          const candidates = doc.querySelectorAll('button, a, div[role="button"], span[role="button"], [class*="button"], [class*="btn"]');
          for (const el of candidates) {
            if (el.offsetParent === null) continue;
            if (!matchesText(el)) continue;
            if (containsDangerousCommand(el)) continue;
            el.click();
            return { clicked: true, text: (el.textContent || '').trim().substring(0, 50), selector: 'text-match' };
          }

          return null;
        }

        // Scan the current document
        var result = scanDoc(document);
        if (result) return JSON.stringify(result);

        // Scan all nested iframes (e.g. webview active-frame)
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var iframeDoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
            if (iframeDoc) {
              result = scanDoc(iframeDoc);
              if (result) return JSON.stringify(result);
            }
          } catch(e) {} // cross-origin iframes will throw
        }

        return JSON.stringify({ clicked: false });
      })();
    `;
  }

  /** Start polling for buttons. */
  start(): void {
    if (this.timer) {
      return;
    }

    const script = this.buildScanScript();

    // Main polling loop: scan all targets for buttons
    this.timer = setInterval(async () => {
      try {
        if (!this.cdp.isConnected) {
          this._onError?.("CDP connection lost");
          this.stop();
          return;
        }

        const raw = await this.cdp.evaluateInAll(script);
        if (!raw) {
          return;
        }

        const result = JSON.parse(raw);
        if (result.clicked) {
          this._clickCount++;
          this._onClick?.({
            buttonText: result.text,
            selector: result.selector,
            timestamp: new Date(),
          });
        }
      } catch (e: any) {
        // Don't spam errors on every poll
      }
    }, this.config.pollingInterval);

    // Periodically refresh CDP connections to pick up new webviews
    this.refreshTimer = setInterval(async () => {
      try {
        const prevCount = this.cdp.connectedCount;
        await this.cdp.refreshConnections();
        const newCount = this.cdp.connectedCount;
        if (newCount !== prevCount) {
          this._onTargetsChanged?.(newCount);
        }
      } catch {
        // ignore refresh errors
      }
    }, 10000); // every 10 seconds
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Update configuration and restart if running. */
  updateConfig(config: AutoClickerConfig): void {
    this.config = config;
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }
}
