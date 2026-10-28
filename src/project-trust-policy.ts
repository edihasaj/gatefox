import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { object, type Message } from "./app-server-connection.js";

type Request = (method: string, params: Message) => Promise<Message>;
const loads = new Set(["thread/start", "thread/resume", "thread/fork"]);
const projectReplies = new Set(["project/read", "project/create", "project/import", "project/update", "project/move"]);
const failure = (message: string): Error => Object.assign(new Error(message), { code: -32001 });
const maxRoots = 1024;

/** Instantiated only for the operator's explicit trustAllProjects choice. Never changes a caller's permissions. */
export class ProjectTrustPolicy {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly raw: Request, private readonly defaultCwd?: string) {}

  async request(method: string, params: Message, send = () => this.raw(method, params)): Promise<Message> {
    // A prediction fork inherits its loaded parent's settings and cannot carry overrides.
    if (method === "thread/fork" && params.experimentalPredictionMode === true) return send();
    if (method === "config/read") {
      await this.synchronize([...await this.registeredRoots(), ...(typeof params.cwd === "string" ? [params.cwd] : [])]);
    } else if (loads.has(method)) {
      let cwd = params.cwd;
      if (cwd == null && typeof params.threadId === "string") {
        cwd = object((await this.raw("thread/read", { threadId: params.threadId, includeTurns: false })).thread).cwd;
        if (typeof cwd !== "string") throw failure("The chat's project folder is unavailable for automatic trust");
      }
      if (cwd == null && method === "thread/start") {
        cwd = this.defaultCwd;
        if (typeof cwd !== "string") throw failure("Select a project folder before starting a chat on this shared executor; its default folder is unavailable for automatic trust");
      }
      if (typeof cwd === "string") await this.synchronize([cwd]);
    }
    const result = await send();
    if (method === "project/list") await this.synchronize(this.pageRoots(result));
    else if (projectReplies.has(method)) await this.synchronize(this.projectRoots(object(result.project)));
    return result;
  }

  private projectRoots(project: Message): string[] {
    if (!Array.isArray(project.roots)) return [];
    return project.roots.map(root => {
      const path = object(root).path;
      if (typeof path !== "string") throw failure("A project folder is unavailable for automatic trust");
      return path;
    });
  }
  private pageRoots(page: Message): string[] {
    if (!Array.isArray(page.data)) throw failure("The registered project list is unavailable for automatic trust");
    return page.data.flatMap(project => this.projectRoots(object(project)));
  }
  private async registeredRoots(): Promise<string[]> {
    const roots: string[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await this.raw("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      roots.push(...this.pageRoots(result));
      if (roots.length > maxRoots) throw failure("Too many project folders to establish automatic trust");
      if (result.nextCursor == null) return roots;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw failure("The registered project list could not be completed for automatic trust");
  }
  private async synchronize(paths: string[]): Promise<void> {
    const bounded = (paths: string[]) => paths.length <= maxRoots && paths.reduce((n, path) => n + Buffer.byteLength(path), 0) <= 256 * 1024 &&
      paths.every(path => isAbsolute(path) && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path));
    if (!bounded(paths)) throw failure("Automatic project trust requires bounded absolute folder paths");
    // The engine tries the canonical spelling first. A stale untrusted canonical row
    // must not defeat the operator's choice when a caller selects /tmp or another alias.
    const canonical = await Promise.all(paths.map(path => realpath(path).catch(error => {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return path;
      throw failure("A project folder's canonical path is unavailable for automatic trust");
    })));
    const roots = [...new Set([...paths, ...canonical])];
    if (!bounded(roots)) throw failure("Automatic project trust requires bounded absolute folder paths");
    if (!roots.length) return Promise.resolve();
    const operation = this.writes.then(() => this.establish(roots));
    this.writes = operation.catch(() => {});
    return operation;
  }
  private async establish(roots: string[]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.raw("config/read", { includeLayers: true, cwd: null });
      const projects = object(object(snapshot.config).projects);
      const missing = roots.filter(root => object(projects[root]).trust_level !== "trusted");
      if (!missing.length) return;
      const user = Array.isArray(snapshot.layers) ? snapshot.layers.map(object).find(layer => object(layer.name).type === "user") : undefined;
      if (!user || user.disabledReason != null || typeof user.version !== "string" || !user.version) {
        throw failure("The native user configuration is unavailable for automatic project trust");
      }
      const edits = missing.map(path => ({ keyPath: `projects."${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}".trust_level`, value: "trusted", mergeStrategy: "replace" }));
      let written: Message;
      try { written = await this.raw("config/batchWrite", { edits, filePath: null, expectedVersion: user.version }); }
      catch (error) {
        if (attempt < 2 && object((error as { data?: unknown }).data).config_write_error_code === "configVersionConflict") continue;
        throw error;
      }
      if (written.status !== "ok") throw failure("Automatic project trust is overridden by another configuration layer");
      const verified = await this.raw("config/read", { includeLayers: true, cwd: null });
      const effective = object(object(verified.config).projects);
      if (roots.some(root => object(effective[root]).trust_level !== "trusted")) {
        throw failure("The native engine did not establish automatic project trust");
      }
      return;
    }
  }
}
