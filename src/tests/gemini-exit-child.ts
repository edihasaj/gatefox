// A process that exits (process.exit) while a Gemini sign-in or session start is in flight. Run by gemini-exit-cleanup.test.ts as
// `node gemini-exit-child.js <login|start> <home>`, with the fake CLI on PATH and its log named by GATEWAY_TEST_GEMINI_LOG.
import { readFileSync } from "node:fs";
import { GeminiSubscription } from "../providers/gemini.js";
import { geminiLogin } from "../providers/gemini-login.js";

const [mode, home] = process.argv.slice(2);
const logged = (op: string) => { try { return readFileSync(process.env.GATEWAY_TEST_GEMINI_LOG!, "utf8").split("\n").some(line => line.includes(`"op":"${op}"`)); } catch { return false; } };
// The point at which the CLI is running and the gateway is still waiting on it.
const waitingFor = mode === "login" ? "consent" : "spawn";
if (mode === "login") void geminiLogin({ home, openUrl: () => {} }).catch(() => {});
else {
  const provider = new GeminiSubscription({ id: "gemini-exit", type: "gemini-subscription", geminiHome: home, models: { alias: "gemini-ultra" } });
  const request = { model: "gemini-ultra", input: [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "start [plain]" }] }] };
  void (async () => { for await (const event of provider.infer(request, new AbortController().signal, { threadId: "exit-child" })) void event; })().catch(() => {});
}
const timer = setInterval(() => { if (logged(waitingFor)) { clearInterval(timer); process.exit(17); } }, 20);
setTimeout(() => process.exit(2), 20000).unref();
