import { Transform } from "node:stream";

export const DEVICE_HEADER = "x-harness-gateway-device";
const DEVICE_PATTERN = /^[0-9a-f]{32}$/;
const HEADER_LIMIT = 32 * 1024;

export function isDevicePseudonym(value: string | undefined): value is string {
  return typeof value === "string" && DEVICE_PATTERN.test(value);
}

/**
 * The native `app-server proxy` speaks HTTP followed by opaque WebSocket frames.  Add the
 * optional local pseudonym to its one opening upgrade without consuming or re-encoding a byte.
 * A malformed or unexpectedly large opening stays an untouched byte pipe.
 */
export function sshProxyDeviceHeader(device: string | undefined): Transform | undefined {
  if (!isDevicePseudonym(device)) return undefined;
  let opening: Buffer<ArrayBufferLike> = Buffer.alloc(0); let pending = true;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, done) {
      if (!pending) { done(null, chunk); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      opening = opening.length ? Buffer.concat([opening, bytes]) : bytes;
      const request = Buffer.from("GET "); const prefixLength = Math.min(opening.length, request.length);
      if (!opening.subarray(0, prefixLength).equals(request.subarray(0, prefixLength))) {
        const unchanged = opening; opening = Buffer.alloc(0); pending = false; done(null, unchanged); return;
      }
      const requestLineEnd = opening.indexOf("\r\n");
      if (requestLineEnd >= 0 && !/^GET\s+\S+\s+HTTP\/1\.[01]$/i.test(opening.subarray(0, requestLineEnd).toString("latin1"))) {
        const unchanged = opening; opening = Buffer.alloc(0); pending = false; done(null, unchanged); return;
      }
      const end = opening.indexOf("\r\n\r\n");
      if (end < 0) {
        if (opening.length <= HEADER_LIMIT) { done(); return; }
        const unchanged = opening; opening = Buffer.alloc(0); pending = false; done(null, unchanged); return;
      }
      pending = false;
      const headerLength = end + 4;
      if (headerLength > HEADER_LIMIT) { const unchanged = opening; opening = Buffer.alloc(0); done(null, unchanged); return; }
      const header = opening.subarray(0, headerLength);
      const text = header.toString("latin1");
      const lines = text.slice(0, -4).split("\r\n");
      let upgrade = false; let connection = false; let hasDeviceHeader = false;
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":"); if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase(); const value = line.slice(colon + 1).trim();
        if (name === "upgrade" && /^websocket$/i.test(value)) upgrade = true;
        if (name === "connection" && value.split(",").some(part => part.trim().toLowerCase() === "upgrade")) connection = true;
        if (name === DEVICE_HEADER) hasDeviceHeader = true;
      }
      if (!upgrade || !connection || hasDeviceHeader) { const unchanged = opening; opening = Buffer.alloc(0); done(null, unchanged); return; }
      const prefix = opening.subarray(0, end);
      const rest = opening.subarray(headerLength);
      opening = Buffer.alloc(0);
      this.push(Buffer.concat([prefix, Buffer.from(`\r\nX-Harness-Gateway-Device: ${device}\r\n\r\n`)]));
      if (rest.length) this.push(rest);
      done();
    },
    flush(done) {
      if (pending && opening.length) this.push(opening);
      opening = Buffer.alloc(0); pending = false; done();
    },
  });
}
