// The test runner's check that a run left nothing of its own in the user's real gateway state. The suite runs under a private
// HOME, and src/test-root-guard.ts refuses the real roots in every test process, so this is the backstop: it notes the entry names
// in `~/.local/state/gw-native` and `~/.local/state/gw-exec` before the run, and afterwards names each new entry whose receipt
// (`<entry>/owner.json`) points its configuration or native home into a temporary folder, which only a test makes. A new entry
// whose receipt names real paths belongs to the gateway the user runs meanwhile and is left alone. Only the two path fields of a
// new receipt are read, nothing is printed but the receipt's own path, and nothing in those folders is ever changed or removed.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const names = folder => { try { return new Set(readdirSync(folder)); } catch { return new Set(); } };

/** Notes the entries of the real state folders under `home` now; the returned function lists the receipts a test left since. */
export function watchRealState(home) {
  const folders = ["gw-native", "gw-exec"].map(name => join(home, ".local", "state", name));
  const before = folders.map(names);
  return () => {
    const temporary = [...new Set([tmpdir(), "/tmp", "/private"].flatMap(base => { const plain = resolve(base); try { return [plain, realpathSync(plain)]; } catch { return [plain]; } }))];
    const isTemporary = path => typeof path === "string" && temporary.some(base => path === base || path.startsWith(base.endsWith("/") ? base : base + "/"));
    const leaks = [];
    folders.forEach((folder, index) => {
      for (const name of names(folder)) {
        if (before[index].has(name)) continue;
        const receipt = join(folder, name, "owner.json");
        let value;
        try { const info = lstatSync(receipt); if (!info.isFile() || info.size > 1 << 20) continue; value = JSON.parse(readFileSync(receipt, "utf8")); }
        catch { continue; }
        if (isTemporary(value?.configPath) || isTemporary(value?.nativeHome)) leaks.push(receipt);
      }
    });
    return leaks;
  };
}
