import type { IncomingMessage, ServerResponse } from "node:http";
import { claudeSessionHolds, recoverClaudeSession } from "./claude-session-recovery.js";

/** Called only after the server's bearer and origin checks. Recovery also requires a loopback connection. */
export async function serveClaudeRecovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) { send(403, { error: "Recovery requires a local operator" }); return; }
  if (req.method === "GET") { send(200, { holds: claudeSessionHolds() }); return; }
  if (req.method !== "POST") { send(405, { error: "Use GET or POST" }); return; }
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk); if (size > 4096) { send(413, { error: "Recovery request is too large" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { send(400, { error: "Invalid recovery request" }); return; }
    try { send(200, recoverClaudeSession(value)); } catch { send(409, { error: "Recovery refused; refresh status and select a stopped crash hold" }); }
  } catch { if (!res.writableEnded) send(400, { error: "Recovery request ended early" }); }
}
