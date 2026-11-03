import { lstatSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The import policy for code this process loads from another installed release (the per-chat rollout imports that release's
 * SDK verifier and forward contract, docs/services.md). Importing a module runs it, so the policy is enforced by Node's own
 * resolver (`module.registerHooks`) on every import it actually resolves, whatever the syntax: static, re-export, dynamic,
 * JSON, `.mjs`, CommonJS `require` or a package. An import whose parent or target lies inside an allowed release package may
 * only resolve to a builtin (`node:`) or to a file inside that same package (its `dist` or `node_modules`) that is a regular
 * file this user owns with one link, not a symlink, and whose folders up to the package are this user's and not writable by
 * others. Anything else fails the import before the module runs. Imports outside allowed packages are untouched.
 */
const roots = new Set<string>();
let registered = false;

export class ForeignImportRefused extends Error {
  constructor() { super("An installed release module is not safe to import"); this.name = "ForeignImportRefused"; }
}

const uid = process.getuid?.();
function rootOf(url: string | undefined): string | undefined {
  if (!url?.startsWith("file:")) return;
  let path: string;
  try { path = fileURLToPath(url); } catch { return; }
  for (const root of roots) if (path.startsWith(root)) return root;
}
const ownedDirectory = (path: string): boolean => {
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink() && (uid === undefined || info.uid === uid) && !(info.mode & 0o022);
};
/** Whether `path` is a file the policy allows inside `root` (a real package path ending in "/"). */
export function allowedForeignFile(path: string, root: string): boolean {
  try {
    if (!path.startsWith(root) || realpathSync(path) !== path) return false;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022)) return false;
    for (let folder = dirname(path); folder.length >= root.length - 1; folder = dirname(folder)) {
      if (!ownedDirectory(folder)) return false;
      if (folder === root.slice(0, -1)) break;
    }
    return true;
  } catch { return false; }
}

/** Puts every import from or into `packageDirectory` under the policy; returns its real path with a trailing "/". */
export function allowForeignRelease(packageDirectory: string): string {
  const root = `${realpathSync(packageDirectory)}/`;
  roots.add(root);
  if (!registered) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        const root = rootOf(context.parentURL) ?? rootOf(resolved.url);
        if (!root || resolved.url.startsWith("node:")) return resolved;
        let path: string;
        try { path = fileURLToPath(resolved.url); } catch { throw new ForeignImportRefused(); }
        if (!allowedForeignFile(path, root)) throw new ForeignImportRefused();
        return resolved;
      },
    });
    registered = true;
  }
  return root;
}
