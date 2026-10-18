import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { once } from "node:events";

/** A loopback upstream that records every request's bearer and framing headers and answers with the given status. */
export async function upstream(status = 200, extra: Record<string, string> = {}) {
  const seen: Array<string | undefined> = []; const connections: number[] = []; const sockets = new Set<Socket>(); const framing: Array<{ length?: string; chunked: boolean }> = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    seen.push(req.headers.authorization); framing.push({ length: req.headers["content-length"], chunked: req.headers["transfer-encoding"] !== undefined }); req.resume();
    res.writeHead(status, { "Content-Type": "text/plain", ...extra }); res.end("ok");
  });
  server.on("connection", socket => { connections.push(1); sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, seen, connections, framing, open: () => sockets.size, port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}
/** A port nothing listens on: connecting to it is refused at once. */
export async function closedPort(): Promise<number> {
  const probe = createTcpServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; probe.close(); await once(probe, "close"); return port;
}
/** Waits until the condition holds (polling), for socket counts that settle after an abort. */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (condition()) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  return condition();
}
