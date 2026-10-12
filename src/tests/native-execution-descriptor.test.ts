import test from "node:test";
import assert from "node:assert/strict";
import { nativeDescriptor, nativeDescriptorFingerprint, nativeExecutionArgs } from "../native-execution-host-engine.js";

const cwd = "/native/workspace";
const descriptor = (args = ["app-server"], directory = cwd) => ({ args, cwd: directory });

test("native descriptors preserve the original arguments and absolute working directory", () => {
  const input = descriptor(["--config", 'model="native"', "app-server", "--listen", "stdio://", "--disable", "remote_control"]);
  const before = structuredClone(input);
  assert.deepEqual(nativeDescriptor(input), before);
  assert.deepEqual(input, before);
});

test("native descriptors reject invalid argument and working-directory shapes", () => {
  const invalid: Array<[string, unknown]> = [
    ["missing descriptor", undefined],
    ["null descriptor", null],
    ["array descriptor", []],
    ["missing fields", {}],
    ["missing arguments", { cwd }],
    ["arguments must be an array", { args: "app-server", cwd }],
    ["empty arguments", descriptor([])],
    ["missing app-server", descriptor(["--config", 'mode="app-server"'])],
    ["proxy command", descriptor(["app-server", "proxy"])],
    ["non-string argument", { args: ["app-server", 1], cwd }],
    ["sparse arguments", { args: [, "app-server"], cwd }],
    ["NUL argument", descriptor(["app-server", "model\0native"])],
    ["missing working directory", { args: ["app-server"] }],
    ["non-string working directory", { args: ["app-server"], cwd: 1 }],
    ["empty working directory", descriptor(["app-server"], "")],
    ["relative working directory", descriptor(["app-server"], "workspace")],
    ["NUL working directory", descriptor(["app-server"], "/native\0/workspace")],
    ["oversized ignored payload", { ...descriptor(), ignored: "a".repeat(4 * 1024 * 1024) }],
  ];
  for (const [label, value] of invalid) assert.throws(() => nativeDescriptor(value), label);
});

test("native descriptors bound argument count and UTF-8 byte lengths", () => {
  const maximumCount = descriptor(["app-server", ...Array<string>(255).fill("argument")]);
  assert.deepEqual(nativeDescriptor(maximumCount), maximumCount);
  assert.throws(() => nativeDescriptor(descriptor([...maximumCount.args, "extra"])));

  for (const argument of ["a".repeat(65535), "é".repeat(32767) + "a"]) {
    assert.equal(Buffer.byteLength(argument), 65535);
    const valid = descriptor(["app-server", argument]);
    assert.deepEqual(nativeDescriptor(valid), valid);
    assert.throws(() => nativeDescriptor(descriptor(["app-server", argument + "a"])));
  }
  const directory = "/" + "é".repeat(32767);
  assert.equal(Buffer.byteLength(directory), 65535);
  assert.deepEqual(nativeDescriptor(descriptor(["app-server"], directory)), descriptor(["app-server"], directory));
  assert.throws(() => nativeDescriptor(descriptor(["app-server"], directory + "a")));
});

test("native descriptors accept exactly 4 MiB and reject one byte more", () => {
  const input = descriptor(["app-server", ...Array<string>(65).fill("")]);
  let remaining = 4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(input));
  for (let index = 1; index < input.args.length; index++) {
    const length = Math.min(65535, remaining);
    input.args[index] = "a".repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(input)), 4 * 1024 * 1024);
  assert.deepEqual(nativeDescriptor(input), input);

  const larger = descriptor([...input.args]);
  larger.args[larger.args.length - 1] += "a";
  assert.equal(Buffer.byteLength(JSON.stringify(larger)), 4 * 1024 * 1024 + 1);
  assert.throws(() => nativeDescriptor(larger));
});

test("native fingerprints ignore only listener and stdio transport arguments", () => {
  const args = ["app-server", "-c", 'model="native"', "--disable", "remote_control"];
  const fingerprint = nativeDescriptorFingerprint(descriptor(args));
  assert.equal(typeof fingerprint, "string");
  assert.ok(fingerprint.length > 0);
  for (const transported of [
    ["--stdio", ...args],
    [...args, "--listen", "stdio://"],
    ["--listen=tcp://127.0.0.1:1234", ...args],
    ["--listen", "unix:///old.sock", ...args, "--stdio", "--listen=stdio://"],
  ]) assert.equal(nativeDescriptorFingerprint(descriptor(transported)), fingerprint);
  assert.equal(nativeDescriptorFingerprint({ cwd, args }), fingerprint);
});

test("native fingerprints include cwd and every remaining argv value in order", () => {
  const args = ["app-server", "-c", 'model="native"', "--disable", "remote_control"];
  const fingerprint = nativeDescriptorFingerprint(descriptor(args));
  const distinct = [
    descriptor(args, "/native/other-workspace"),
    descriptor(["app-server", "-c", 'model="changed"', "--disable", "remote_control"]),
    descriptor(["app-server", "--disable", "remote_control", "-c", 'model="native"']),
    descriptor([...args, "--listen-timeout", "10"]),
    descriptor([...args, "--stdio=false"]),
    descriptor([...args, "--config=features.remote_control=false"]),
    descriptor([...args, "--model", "gpt-6-astra"]),
  ];
  for (const input of distinct) assert.notEqual(nativeDescriptorFingerprint(input), fingerprint);
  assert.notEqual(nativeDescriptorFingerprint(descriptor(["app-server", "ab", "c"])), nativeDescriptorFingerprint(descriptor(["app-server", "a", "bc"])));
  assert.deepEqual(args, ["app-server", "-c", 'model="native"', "--disable", "remote_control"]);
});

test("native execution replaces transport while preserving all config and model flags", () => {
  const preserved = [
    "app-server",
    "-c", 'model="native"',
    "--config", 'model_provider="native"',
    '--config=model_catalog_json="/native/catalog.json"',
    "-c", "features.code_mode_tool_description_first=true",
    "--disable", "codex_hooks",
    "-c", "features.guardianv2.thread_context=false",
    "--enable", "remote_control",
    "--disable", "remote_control",
    "--config=features.remote_control=false",
    "--model", "gpt-6-astra",
    "--profile", "daily",
    "--listen-timeout", "15",
    "--stdio=false",
  ];
  const input = ["--stdio", "--listen", "stdio://", ...preserved, "--listen=tcp://127.0.0.1:1234", "--listen", "unix:///old.sock"];
  const before = [...input];
  assert.deepEqual(nativeExecutionArgs(input, "/managed/native.sock", false), [...preserved, "--listen", "unix:///managed/native.sock"]);
  assert.deepEqual(input, before);
  assert.deepEqual(nativeExecutionArgs(input, "/managed/native.sock", true), [...preserved, "--listen", "unix:///managed/native.sock"]);
  assert.deepEqual(input, before);
});

test("native execution preserves existing arguments and rejects remote-control ownership conflicts", () => {
  const args = ["app-server", "--disable", "remote_control"];
  assert.deepEqual(nativeExecutionArgs(args, "/managed/native.sock", false), [...args, "--listen", "unix:///managed/native.sock"]);
  assert.deepEqual(nativeExecutionArgs(args, "/managed/native.sock", true), [...args, "--listen", "unix:///managed/native.sock"]);
  assert.throws(() => nativeExecutionArgs(["app-server", "--remote-control"], "/managed/native.sock", true), /conflicts with managed relay/);
  assert.deepEqual(nativeExecutionArgs(["app-server", "--remote-control"], "/managed/native.sock", false), ["app-server", "--remote-control", "--listen", "unix:///managed/native.sock"]);
  assert.deepEqual(args, ["app-server", "--disable", "remote_control"]);
});
