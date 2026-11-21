import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { ProviderError } from "./provider.js";

/**
 * A minimal Agent Client Protocol connection over stdio: JSON-RPC 2.0, one message per line. It is the shared client
 * behind every CLI provider that speaks ACP (`grok agent stdio`, `gemini --acp`), parameterised by the provider name
 * that appears in its fixed error prose. It never logs frames: they carry prompts, tool arguments and results.
 * Requests from the agent that the handler does not answer get a JSON-RPC "method not found" error, so the agent can
 * never wait on the client.
 */
export class AcpError extends Error { constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); } }

export interface AcpHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  /** An agent-to-client request. Throw an AcpError to answer with an error; anything else is the result. */
  request(method: string, params: Record<string, unknown>): unknown | Promise<unknown>;
  /** Called once when the process or its output ended. */
  closed(reason: "exited" | "failed", error?: ProviderError): void;
}
export interface AcpOptions { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
const maxLine = 8 * 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const acpObject = (value: unknown): Record<string, unknown> => isObject(value) ? value : {};

export class AcpConnection {
  private readonly child: ChildProcess;
  private nextId = 0; private ended = false; private killed = false;
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  /**
   * `label` names the provider in the fixed error prose; `extensions` are the method prefixes a CLI may use for its own
   * notifications and requests, whose `params: null` is treated as absent rather than a protocol fault.
   */
  constructor(options: AcpOptions, private readonly handlers: AcpHandlers, private readonly label = "Provider",
    private readonly extensions: readonly string[] = ["_x.ai/"]) {
    // A new process group lets one SIGKILL end the CLI and anything it started.
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stdin!.on("error", () => {});
    this.child.stderr!.resume();
    this.child.on("error", () => this.end("failed"));
    this.child.on("exit", () => this.end("exited"));
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on("line", line => this.accept(line));
    lines.on("close", () => this.end("exited"));
  }

  get pid(): number | undefined { return this.child.pid; }
  get closed(): boolean { return this.ended; }

  private end(reason: "exited" | "failed", error?: ProviderError): void {
    if (this.ended) return;
    this.ended = true;
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error ?? new ProviderError("cli_failed", `${this.label} CLI closed before completion`, 502)); }
    this.pending.clear();
    this.handlers.closed(reason, error);
  }

  private send(message: Record<string, unknown>): void {
    if (this.ended || !this.child.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  /** One request; `timeoutMs` bounds the wait (a prompt has none: it lasts as long as the model works). */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.ended) return Promise.reject(new ProviderError("cli_failed", `${this.label} CLI closed before completion`, 502));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => { this.pending.delete(id); reject(new ProviderError("timeout", `${this.label} CLI did not answer in time`, 504)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  /** A frame whose shape breaks the protocol ends the connection: nothing is read from it, and nothing is coerced. */
  private malformed(): void {
    this.kill(); this.end("failed", new ProviderError("invalid_stream", `${this.label} sent a malformed protocol frame`, 502, { code: "invalid_frame", event: `${this.label.toLowerCase()}.acp` }));
  }

  private accept(line: string): void {
    if (this.ended) return;
    if (line.length > maxLine) { this.kill(); return; }
    let decoded: unknown;
    try { decoded = JSON.parse(line); } catch { return; }
    if (!isObject(decoded)) return this.malformed();
    const { id, method, params } = decoded;
    // Every field is type-checked before use: a wrong type anywhere ends the connection with invalid_stream. The real Grok CLI sends
    // `params: null` on its `_x.ai/*` extension notifications and requests (which are ignored or rejected anyway): that is absent.
    const nullExtension = params === null && typeof method === "string" && this.extensions.some(prefix => method.startsWith(prefix));
    if (params !== undefined && !nullExtension && !isObject(params)) return this.malformed();
    if (method === undefined) {
      if (typeof id !== "number") { if (id === undefined || id === null || typeof id === "string") return; return this.malformed(); }
      const entry = this.pending.get(id); if (!entry) return;
      const { error, result } = decoded;
      let failure: AcpError | undefined; let value: Record<string, unknown> = {};
      if (error !== undefined) {
        if (!isObject(error) || typeof error.code !== "number" || !Number.isFinite(error.code) || typeof error.message !== "string") return this.malformed();
        failure = new AcpError(error.code, error.message, error.data);
      } else if (isObject(result)) value = result;
      else return this.malformed();
      this.pending.delete(id); clearTimeout(entry.timer);
      if (failure) entry.reject(failure); else entry.resolve(value);
      return;
    }
    if (typeof method !== "string" || (id !== undefined && id !== null && typeof id !== "number" && typeof id !== "string")) return this.malformed();
    const fields = isObject(params) ? params : {};
    if (id === undefined || id === null) { try { this.handlers.notification(method, fields); } catch { /* A handler fault never ends the reader. */ } return; }
    void (async () => {
      try { this.send({ id, result: await this.handlers.request(method, fields) ?? {} }); }
      catch (error) { this.send({ id, error: { code: error instanceof AcpError ? error.code : -32601, message: error instanceof AcpError ? error.message : "Method not found" } }); }
    })();
  }

  /**
   * SIGKILL of the whole process group; the CLI gets no chance to act on anything more. The leader having exited
   * does not mean its descendants did, so the group is always signalled once (ESRCH: nothing of it is left).
   */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const pid = this.child.pid;
    try { if (pid) process.kill(-pid, "SIGKILL"); else this.child.kill("SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      try { this.child.kill("SIGKILL"); } catch { /* Gone already. */ }
    }
  }
}
