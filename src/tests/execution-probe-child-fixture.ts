import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let text = "";
for await (const chunk of process.stdin) text += String(chunk);
const input = JSON.parse(text) as { root: string };
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await writeFile(join(input.root, "probe-descendant.pid"), String(descendant.pid), { mode: 0o600 });
setInterval(() => {}, 1000);
