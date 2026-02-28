import { CDPClient } from "./cdp-client";

export interface AutoClickerConfig {
  pollingInterval: number;
  clickCooldown: number;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _clickCount = 0;
  private _lastClickTime = 0;
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
    // Pre-escape patterns for regex word boundary matching
    const escapedPatterns = this.config.buttonTextPatterns.map((p) =>
      p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()
    );
    const textPatterns = JSON.stringify(escapedPatterns);
    const dangerousPatterns = JSON.stringify(
      this.config.dangerousCommandPatterns
    );

    return `
      (function() {
        var selectors = ${selectors};
        var textPatterns = ${textPatterns};
        var dangerousPatterns = ${dangerousPatterns}.map(function(p) { return new RegExp(p, 'i'); });

        function isVisible(el) {
          if (!el) return false;
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function containsDangerousCommand(el) {
          var container = el;
          for (var i = 0; i < 5 && container.parentElement; i++) {
            container = container.parentElement;
          }
          var text = container.innerText || '';
          return dangerousPatterns.some(function(p) { return p.test(text); });
        }

        function matchesText(el) {
          var text = (el.textContent || el.title || el.ariaLabel || '').trim();
          if (!text) return false;
          return textPatterns.some(function(p) {
            var regex = new RegExp('\\\\b' + p + '\\\\b', 'i');
            return regex.test(text);
          });
        }

        function scanDoc(doc) {
          if (!doc) return null;

          // Try CSS selectors first
          for (var s = 0; s < selectors.length; s++) {
            try {
              var buttons = doc.querySelectorAll(selectors[s]);
              for (var b = 0; b < buttons.length; b++) {
                if (!isVisible(buttons[b])) continue;
                if (containsDangerousCommand(buttons[b])) continue;
                buttons[b].click();
                return { clicked: true, text: (buttons[b].textContent || '').trim().substring(0, 50), selector: selectors[s] };
              }
            } catch(e) {}
          }

          // Fallback: scan by text content (targeted selectors only)
          var candidates = doc.querySelectorAll('button, [role="button"], a.monaco-button');
          for (var c = 0; c < candidates.length; c++) {
            if (!isVisible(candidates[c])) continue;
            if (!matchesText(candidates[c])) continue;
            if (containsDangerousCommand(candidates[c])) continue;
            candidates[c].click();
            return { clicked: true, text: (candidates[c].textContent || '').trim().substring(0, 50), selector: 'text-match' };
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

  /** Start polling for buttons using setTimeout to prevent concurrent evaluations. */
  start(): void {
    if (this.timer) {
      return;
    }

    const script = this.buildScanScript();

    const poll = async () => {
      try {
        if (!this.cdp.isConnected) {
          this.stop();
          this._onError?.("CDP connection lost");
          return;
        }

        // Skip if within cooldown period after last click
        const now = Date.now();
        if (now - this._lastClickTime < this.config.clickCooldown) {
          return;
        }

        const raw = await this.cdp.evaluateInAll(script);
        if (!raw) {
          return;
        }

        const result = JSON.parse(raw);
        if (result.clicked) {
          this._clickCount++;
          this._lastClickTime = Date.now();
          this._onClick?.({
            buttonText: result.text,
            selector: result.selector,
            timestamp: new Date(),
          });
        }
      } catch {
        // Transient errors (JSON parse, CDP timeout) - ignore and retry next cycle
      } finally {
        // Schedule next poll only after current one completes (prevents concurrent evaluations)
        if (this.timer !== null) {
          this.timer = setTimeout(poll, this.config.pollingInterval);
        }
      }
    };

    // Mark as running and start first poll
    this.timer = setTimeout(poll, 0);

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
      clearTimeout(this.timer);
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
