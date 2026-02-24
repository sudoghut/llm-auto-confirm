import * as http from "http";
import WebSocket from "ws";

interface CDPTarget {
  id: string;
  title: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CDPResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/** A single WebSocket connection to one CDP target. */
class CDPConnection {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  constructor(
    public readonly targetId: string,
    public readonly targetType: string,
    public readonly targetTitle: string
  ) {}

  async connect(wsUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, 5000);

      this.ws = new WebSocket(wsUrl, {
        headers: { Origin: "vscode-file://vscode-app" },
      });

      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve(true);
      });
      this.ws.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      this.ws.on("message", (raw) => {
        try {
          const msg: CDPResponse = JSON.parse(raw.toString());
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              resolve(msg.result);
            }
          }
        } catch {
          // ignore malformed messages
        }
      });

      this.ws.on("close", () => {
        this.ws = null;
        for (const { reject } of this.pending.values()) {
          reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  async evaluate(expression: string): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP request timed out"));
        }
      }, 5000);
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pending.clear();
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

/**
 * Multi-target CDP client.
 * Connects to ALL relevant targets (main page + webview iframes)
 * so it can scan buttons inside extension webviews (e.g. Claude).
 */
export class CDPClient {
  private connections = new Map<string, CDPConnection>();

  constructor(private port: number) {}

  /** Fetch all available CDP targets. */
  private async fetchTargets(): Promise<CDPTarget[]> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/json`,
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.on("error", () => resolve([]));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve([]);
      });
    });
  }

  /** Connect to all relevant targets (pages + iframes). */
  async connect(): Promise<boolean> {
    const targets = await this.fetchTargets();

    // We care about: main page + iframe webviews (where extension UIs live)
    const relevant = targets.filter(
      (t) =>
        (t.type === "page" || t.type === "iframe") &&
        t.webSocketDebuggerUrl
    );

    if (relevant.length === 0) {
      return false;
    }

    let anyConnected = false;
    for (const target of relevant) {
      if (this.connections.has(target.id)) {
        // Already connected
        if (this.connections.get(target.id)!.isConnected) {
          anyConnected = true;
          continue;
        }
        // Stale connection, remove
        this.connections.delete(target.id);
      }

      const conn = new CDPConnection(
        target.id,
        target.type,
        target.title || target.url || ""
      );
      const ok = await conn.connect(target.webSocketDebuggerUrl!);
      if (ok) {
        this.connections.set(target.id, conn);
        anyConnected = true;
      }
    }

    // Remove connections to targets that no longer exist
    const currentIds = new Set(relevant.map((t) => t.id));
    for (const [id, conn] of this.connections) {
      if (!currentIds.has(id)) {
        conn.disconnect();
        this.connections.delete(id);
      }
    }

    return anyConnected;
  }

  /** Refresh connections: discover new targets, drop stale ones. */
  async refreshConnections(): Promise<void> {
    await this.connect();
  }

  /** Evaluate an expression in ALL connected targets. Returns first truthy result or null. */
  async evaluateInAll(expression: string): Promise<any> {
    for (const [, conn] of this.connections) {
      if (!conn.isConnected) {
        continue;
      }
      try {
        const result = await conn.evaluate(expression);
        const value = result?.result?.value;
        if (value) {
          return value;
        }
      } catch {
        // target may have been destroyed, continue to next
      }
    }
    return null;
  }

  /** Evaluate in a single target (for backward compat). */
  async evaluate(expression: string): Promise<any> {
    return this.evaluateInAll(expression);
  }

  /** Disconnect from all targets. */
  disconnect(): void {
    for (const [, conn] of this.connections) {
      conn.disconnect();
    }
    this.connections.clear();
  }

  get isConnected(): boolean {
    for (const [, conn] of this.connections) {
      if (conn.isConnected) {
        return true;
      }
    }
    return false;
  }

  get connectedCount(): number {
    let count = 0;
    for (const [, conn] of this.connections) {
      if (conn.isConnected) {
        count++;
      }
    }
    return count;
  }
}
