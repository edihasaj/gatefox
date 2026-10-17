/**
 * HTTP upgrades (WebSocket handshakes among them) and unreadable request targets. This API speaks no upgrade
 * protocol, so an upgrade is refused on its raw socket before admission, before any provider and without a body
 * a caller could be misled by. The refusal never throws and never leaves a socket open.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { validBearer } from "./config.js";

/** How long a refused upgrade socket may stay open for a client that never reads the refusal. */
export const upgradeRefusalGraceMs = 2000;

const isUpgrade = (value: string | undefined): boolean => value !== undefined && !/^(no-op|none|unset)$/i.test(value);
/** Node's parser takes a request as an upgrade only when `Connection` names the `upgrade` token beside an `Upgrade` header. */
const connectionNamesUpgrade = (value: string | undefined): boolean => value !== undefined && value.split(",").some(token => token.trim().toLowerCase() === "upgrade");
/** True for a request that asks to switch protocols. A bare `Upgrade` header (`h2c` on a POST, say) is an ordinary request. */
export const isUpgradeRequest = (headers: IncomingHttpHeaders): boolean => isUpgrade(headers.upgrade) && connectionNamesUpgrade(headers.connection);

/** The path of a request target, or nothing when the target cannot be parsed (`GET http://[ HTTP/1.1`). Never throws. */
export function requestPath(target: string | undefined): string | undefined {
  try { return new URL(target || "/", "http://127.0.0.1").pathname; } catch { return; }
}

const statusText = (status: number): string => status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 426 ? "Upgrade Required" : "Bad Request";
/**
 * Refuses an upgrade on its raw socket. The socket is closed once the refusal is flushed, and after a short grace if the
 * client never reads it: an `http.Server` allows half-open sockets and applies no timeout after an upgrade, so a plain
 * `end()` would hold a client that keeps its half open (and the server's close) forever. A 426 carries no body.
 */
function refuseUpgrade(socket: Duplex, status: number, error?: { code: string; message: string }): void {
  socket.on("error", () => { /* A client that resets before reading the refusal is expected. */ });
  const payload = error ? JSON.stringify({ error }) : "";
  const head = `HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\n` +
    (error ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : "Content-Length: 0\r\n");
  const timer = setTimeout(() => socket.destroy(), upgradeRefusalGraceMs); timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.end(`${head}\r\n${payload}`, () => socket.destroy());
}

/** Answers an upgrade request: 400 for an unreadable target, then the origin and token checks, 426 for the Responses path, 404 elsewhere. */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, token: string): void {
  const path = requestPath(req.url);
  if (path === undefined) return refuseUpgrade(socket, 400, { code: "invalid_request", message: "Request target is not valid" });
  if (req.headers.origin) return refuseUpgrade(socket, 403, { code: "cross_origin", message: "Browser cross-origin requests are disabled" });
  if (!validBearer(req.headers.authorization, token)) return refuseUpgrade(socket, 401, { code: "authentication", message: "Gateway bearer token required" });
  if (path === "/v1/responses") return refuseUpgrade(socket, 426);
  refuseUpgrade(socket, 404, { code: "not_found", message: "Unknown endpoint" });
}

/** The same 426 for Node versions that hand an upgrade to the request handler; it carries no body. */
export const sendUpgradeRefusal = (res: ServerResponse): void => { res.writeHead(426, { Connection: "close", "Content-Length": "0" }); res.end(); };
