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
 * Also detects keyboard-based permission prompts (e.g. Claude Code)
 * and responds by clicking the "Yes" option or sending keyboard events.
 * Scans ALL connected targets (main page + webview iframes).
 */
export class AutoClicker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _clickCount = 0;
  private _lastClickTime = 0;
  private _lastPromptCount = 0;
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

  /**
   * Build the JavaScript that runs inside each target.
   * Handles both clickable buttons AND text-based permission prompts.
   */
  private buildScanScript(): string {
    const selectors = JSON.stringify(this.config.buttonSelectors);
    const escapedPatterns = this.config.buttonTextPatterns.map((p) =>
      p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()
    );
    const textPatterns = JSON.stringify(escapedPatterns);
    const dangerousPatterns = JSON.stringify(
      this.config.dangerousCommandPatterns
    );
    const lastPromptCount = this._lastPromptCount;

    return `
      (function() {
        var selectors = ${selectors};
        var textPatterns = ${textPatterns};
        var dangerousPatterns = ${dangerousPatterns}.map(function(p) { return new RegExp(p, 'i'); });
        var LAST_PROMPT_COUNT = ${lastPromptCount};

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

        function textIsDangerous(text) {
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

        // --- Phase 1: Click standard buttons ---
        function scanDocForButtons(doc) {
          if (!doc) return null;

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

        // --- Phase 2: Detect and handle permission prompts ---
        // Permission prompts contain "Allow ..." with numbered Yes/No options.
        // They may render as <pre><code> blocks OR as structured UI components.
        function isPermissionPrompt(text) {
          return /^Allow\\s/.test(text) &&
                 /\\d\\s+Yes\\b/i.test(text) &&
                 /\\d\\s+No\\b/i.test(text);
        }

        function findPermissionPrompts(doc) {
          if (!doc) return [];

          var prompts = [];
          var all = doc.querySelectorAll('*');

          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var text = (el.textContent || '').trim();

            if (text.length > 500 || text.length < 30) continue;
            if (!isPermissionPrompt(text)) continue;

            // Only keep innermost matching elements
            var hasMatchingChild = false;
            for (var c = 0; c < el.children.length; c++) {
              var ct = (el.children[c].textContent || '').trim();
              if (ct.length >= 30 && isPermissionPrompt(ct)) {
                hasMatchingChild = true;
                break;
              }
            }
            if (hasMatchingChild) continue;

            if (!textIsDangerous(text)) {
              prompts.push({ el: el, text: text });
            }
          }

          return prompts;
        }

        function tryClickYesOption(promptEl) {
          // Search within the prompt container for a "Yes" option to click
          var descendants = promptEl.querySelectorAll('*');
          for (var j = 0; j < descendants.length; j++) {
            var child = descendants[j];
            var childText = (child.textContent || '').trim();
            // Match elements whose text is exactly "Yes" (the option label)
            if (/^Yes$/i.test(childText) && child.children.length === 0) {
              // Click the element itself, or its closest interactive parent
              var target = child;
              var p = child.parentElement;
              while (p && p !== promptEl) {
                var pText = (p.textContent || '').trim();
                // Stop at the option row level (contains just "Yes" or "1  Yes")
                if (/^(\\d\\s+)?Yes$/i.test(pText)) {
                  target = p;
                }
                p = p.parentElement;
              }
              target.click();
              return true;
            }
          }
          return false;
        }

        function trySubmitViaInput(doc) {
          // Fallback: type "1" in the input field and submit
          var textarea = doc.querySelector('textarea');
          if (textarea) {
            textarea.focus();
            try {
              var setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype, 'value'
              ).set;
              setter.call(textarea, '1');
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
              var form = textarea.closest('form');
              if (form) {
                if (form.requestSubmit) {
                  form.requestSubmit();
                } else {
                  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
                return true;
              }
            } catch(e) {}
          }

          // Try contenteditable
          var editable = doc.querySelector('[contenteditable="true"]');
          if (editable) {
            editable.focus();
            editable.textContent = '1';
            editable.dispatchEvent(new Event('input', { bubbles: true }));
            var form = editable.closest('form');
            if (form) {
              if (form.requestSubmit) {
                form.requestSubmit();
              } else {
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
              return true;
            }
          }

          return false;
        }

        function handlePermissionPrompts(doc) {
          var prompts = findPermissionPrompts(doc);
          var promptCount = prompts.length;

          if (promptCount <= LAST_PROMPT_COUNT) {
            return { clicked: false, promptCount: promptCount };
          }

          // New prompt detected - try to handle the latest one
          var latest = prompts[prompts.length - 1];
          var promptText = latest.text.substring(0, 100);

          // Strategy 1: Click the "Yes" option element directly
          if (tryClickYesOption(latest.el)) {
            return { clicked: true, promptCount: promptCount, text: promptText, selector: 'prompt-yes-click' };
          }

          // Strategy 2: Type "1" in the input field and submit
          if (trySubmitViaInput(doc)) {
            return { clicked: true, promptCount: promptCount, text: promptText, selector: 'prompt-input-submit' };
          }

          // Could not auto-confirm - return detection info for keyboard fallback
          return { clicked: false, promptDetected: true, promptCount: promptCount, promptText: promptText };
        }

        // --- Main scan logic ---
        function scanDocFull(doc) {
          if (!doc) return null;

          // Phase 1: Try standard button clicking
          var buttonResult = scanDocForButtons(doc);
          if (buttonResult) return buttonResult;

          // Phase 2: Handle permission prompts
          var promptResult = handlePermissionPrompts(doc);
          if (promptResult && (promptResult.clicked || promptResult.promptDetected)) {
            return promptResult;
          }

          // Return prompt count for tracking even if no action taken
          if (promptResult && promptResult.promptCount !== undefined) {
            return { clicked: false, promptCount: promptResult.promptCount };
          }

          return null;
        }

        // Scan the current document
        var result = scanDocFull(document);
        if (result && result.clicked) return JSON.stringify(result);

        // Scan all nested iframes
        var iframes = document.querySelectorAll('iframe');
        var bestResult = result;
        for (var i = 0; i < iframes.length; i++) {
          try {
            var iframeDoc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
            if (iframeDoc) {
              var iResult = scanDocFull(iframeDoc);
              if (iResult && iResult.clicked) return JSON.stringify(iResult);
              // Keep the result with highest prompt count
              if (iResult && iResult.promptCount !== undefined) {
                if (!bestResult || (iResult.promptCount || 0) > (bestResult.promptCount || 0)) {
                  bestResult = iResult;
                }
              }
            }
          } catch(e) {}
        }

        return JSON.stringify(bestResult || { clicked: false, promptCount: 0 });
      })();
    `;
  }

  /** Send keyboard event to select option "1" (Yes) via CDP. */
  private async confirmPromptViaKeyboard(): Promise<void> {
    await this.cdp.dispatchKeyEvent("keyDown", "1", "Digit1", 49);
    await this.cdp.dispatchKeyEvent("keyUp", "1", "Digit1", 49);
  }

  /** Start polling. */
  start(): void {
    if (this.timer) {
      return;
    }

    const poll = async () => {
      try {
        if (!this.cdp.isConnected) {
          this.stop();
          this._onError?.("CDP connection lost");
          return;
        }

        const now = Date.now();
        if (now - this._lastClickTime < this.config.clickCooldown) {
          return;
        }

        // Build script fresh each cycle (embeds current _lastPromptCount)
        const script = this.buildScanScript();
        const raw = await this.cdp.evaluateInAll(script);
        if (!raw) return;

        const result = JSON.parse(raw);

        if (result.clicked) {
          // Successfully clicked a button or confirmed a prompt
          if (result.promptCount !== undefined) {
            this._lastPromptCount = result.promptCount;
          }
          this._clickCount++;
          this._lastClickTime = Date.now();
          this._onClick?.({
            buttonText: result.text || "Confirmed",
            selector: result.selector || "unknown",
            timestamp: new Date(),
          });
        } else if (result.promptDetected) {
          // Prompt detected but click/input methods failed - try keyboard
          try {
            await this.confirmPromptViaKeyboard();
            if (result.promptCount !== undefined) {
              this._lastPromptCount = result.promptCount;
            }
            this._clickCount++;
            this._lastClickTime = Date.now();
            this._onClick?.({
              buttonText: result.promptText || "Permission prompt",
              selector: "keyboard-fallback",
              timestamp: new Date(),
            });
          } catch {
            // keyboard dispatch failed, will retry next cycle
          }
        } else if (result.promptCount !== undefined) {
          // Update tracking even if no action taken
          if (result.promptCount < this._lastPromptCount) {
            // Prompts were removed (page refresh, new session)
            this._lastPromptCount = result.promptCount;
          }
        }
      } catch {
        // Transient errors - ignore and retry next cycle
      } finally {
        if (this.timer !== null) {
          this.timer = setTimeout(poll, this.config.pollingInterval);
        }
      }
    };

    this.timer = setTimeout(poll, 0);

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
    }, 10000);
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
