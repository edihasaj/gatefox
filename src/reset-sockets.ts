import { Socket } from "node:net";

const guarded = Symbol.for("harness-gateway.reset-sockets.v1");
type Method = ((value: number) => Socket) & { [guarded]?: true };

/**
 * Node 24's `fetch` sets a type of service on a connection before its first write. On macOS that call fails when the server has
 * already reset the connection, and Node throws it outside any promise, so one machine going away at the wrong moment would end
 * the whole gateway (nodejs/undici#5544). Undici's own fix, which the bundled release does not have yet, ignores the failure:
 * the write that follows still rejects the request with the real network error. Every other error is kept.
 */
export function tolerateResetSockets(prototype: object = Socket.prototype): void {
  const target = prototype as { setTypeOfService?: Method };
  const original = target.setTypeOfService;
  if (typeof original !== "function" || original[guarded]) return;
  const tolerant: Method = function (this: Socket, value: number): Socket {
    try { return original.call(this, value); }
    catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.syscall !== "setTypeOfService") throw error;
      return this;
    }
  };
  tolerant[guarded] = true;
  target.setTypeOfService = tolerant;
}
