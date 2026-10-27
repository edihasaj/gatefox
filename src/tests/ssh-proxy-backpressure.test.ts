import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { shortFolder } from "./short-folder.js";

// Use the real signed copy loop: an async JavaScript fixture would conceal inherited nonblocking stdout.
const native = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
test("the SSH proxy preserves a large native byte stream while its caller stops reading", { skip: process.platform !== "darwin", timeout: 20000 }, async t => {
  if (!await access(native).then(() => true, () => false)) return t.skip("No signed native proxy");
  const folder = await shortFolder("gw-proxy-pressure-");
  const socket = join(folder.directory, "copy.sock"), config = join(folder.directory, "config.json");
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const peers = new Set<Socket>();
  let connected!: () => void; const ready = new Promise<void>(resolve => { connected = resolve; });
  const server = createServer({ allowHalfOpen: true }, peer => {
    peers.add(peer); peer.on("error", () => {}); peer.once("close", () => peers.delete(peer));
    peer.resume(); connected();
    // Waiting until the reader is attached below would miss the regression.
    peer.end(payload);
  });
  await mkdir(join(folder.directory, "state"));
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: join(folder.directory, "state"), providers: [] }));
  server.listen(socket); await once(server, "listening");
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "codex-shim", "--ssh", "--config", config, "--codex", native,
    "--", "app-server", "proxy", "--sock", socket], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: folder.directory, CODEX_HOME: folder.directory },
  });
  const closed = once(child, "close");
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  child.stdout.pause(); child.stdin.end();
  try {
    await ready; await delay(250);
    const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stdout.resume();
    const [code] = await closed;
    assert.equal(code, 0, "Native proxy exited while the caller was backpressured");
    assert.equal(/os error 35|Resource temporarily unavailable/.test(stderr), false);
    assert.deepEqual(Buffer.concat(chunks), payload, "The proxy must flush every opaque byte before completing");
  } finally {
    child.kill("SIGTERM"); for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await folder.remove();
  }
});
