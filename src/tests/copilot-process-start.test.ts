import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { processStart, type PsSpawn } from "../providers/copilot-directories.js";

// `processStart` feeds the startup sweep and every folder name. A `ps` that cannot be spawned (EPERM inside a macOS sandbox) must
// read as "start unknown", never as a rejection that stops `gateway serve` before it listens.

test("processStart resolves undefined when spawning ps throws synchronously", { timeout: 5000 }, async () => {
  const spawn: PsSpawn = () => { throw Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" }); };
  assert.equal(await processStart(process.pid, spawn), undefined);
});

test("processStart resolves undefined when the child emits an error and never calls back", { timeout: 5000 }, async () => {
  const spawn: PsSpawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" })));
    return child;
  };
  assert.equal(await processStart(process.pid, spawn), undefined);
});

test("processStart resolves undefined when the callback reports an error", { timeout: 5000 }, async () => {
  const spawn: PsSpawn = (_file, _args, _options, callback) => { queueMicrotask(() => callback(new Error("spawn ps ENOENT"), "")); return new EventEmitter(); };
  assert.equal(await processStart(process.pid, spawn), undefined);
});

test("processStart still reads a start time from ps output", { timeout: 5000 }, async () => {
  const spawn: PsSpawn = (_file, _args, _options, callback) => { queueMicrotask(() => callback(null, "Thu Jan  1 00:00:10 1970\n")); return new EventEmitter(); };
  assert.equal(await processStart(process.pid, spawn), 10);
});
