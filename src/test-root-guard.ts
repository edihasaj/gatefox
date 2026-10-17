import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * node:test marks the process of every test file, and each process a test starts with its environment, with
 * `NODE_TEST_CONTEXT`. Such a process may use a per-user root (the host folders under `~/.local/state/gw-exec`, the
 * native-home receipts and relay homes under `gw-native`, the SSH control homes under `gw-ssh`, the SDK socket rendezvous
 * `/tmp/codex-daemon-<uid>`, or a native Codex home that a gateway home links) only inside a temporary folder. Under
 * `npm test` the runner points HOME and TMPDIR into one private folder, so the default roots already lie there; a test file
 * run on its own with the real HOME must isolate the root (src/tests/isolated-execution-roots.ts) or give its processes a
 * private HOME. Anything else would write into the real folders, so it fails here instead, naming only the root's kind.
 * A gateway process never runs with `NODE_TEST_CONTEXT`, so this returns the root unchanged there.
 */
export function testSafeRoot(root: string, name: string, options: { fixed?: boolean } = {}): string {
  if (process.env.NODE_TEST_CONTEXT === undefined) return root;
  // A fixed root (the SDK rendezvous) is the same folder whatever HOME or TMPDIR say, so a test may never use it.
  if (options.fixed) throw new Error(`A test process reached the real ${name}; isolate it (src/tests/isolated-execution-roots.ts)`);
  // Short socket folders are made under /tmp, which never holds a home's state; its fixed SDK rendezvous is refused above.
  const bases = [tmpdir(), process.env.GATEWAY_TEST_TMPDIR, process.platform === "win32" ? undefined : "/tmp"].filter((base): base is string => typeof base === "string" && base.length > 0);
  const spellings = (path: string) => { const plain = resolve(path); try { return [plain, realpathSync(plain)]; } catch { return [plain]; } };
  const inside = (base: string, path: string) => { const rest = relative(base, path); return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest)); };
  const target = resolve(root);
  if (bases.flatMap(spellings).some(base => inside(base, target))) return root;
  throw new Error(`A test process reached the real ${name}; isolate it (src/tests/isolated-execution-roots.ts) or run the file through node scripts/run-tests.mjs`);
}
