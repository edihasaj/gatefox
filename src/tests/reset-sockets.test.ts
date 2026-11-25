import test from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { tolerateResetSockets } from "../reset-sockets.js";

type Service = Socket & { _handle: unknown; setTypeOfService?: (value: number) => Socket };

test("a connection that was reset before its first write cannot end the process", { skip: typeof (Socket.prototype as Service).setTypeOfService !== "function" }, () => {
  const socket = new Socket() as Service;
  const handle = socket._handle; socket._handle = { setTypeOfService: () => -22 };
  try {
    const prototype = { setTypeOfService: (Socket.prototype as Service).setTypeOfService };
    assert.throws(() => prototype.setTypeOfService!.call(socket, 1), { syscall: "setTypeOfService" }, "Node itself throws");
    tolerateResetSockets(prototype); const once = prototype.setTypeOfService; tolerateResetSockets(prototype);
    assert.equal(prototype.setTypeOfService, once, "applied once"); assert.equal(prototype.setTypeOfService!.call(socket, 2), socket);
    assert.throws(() => prototype.setTypeOfService!.call(socket, Number.NaN), TypeError, "a wrong argument is still an error");
  } finally { socket._handle = handle; socket.destroy(); }
});

test("a runtime without the call is left alone", () => { const prototype = {}; tolerateResetSockets(prototype); assert.deepEqual(prototype, {}); });
