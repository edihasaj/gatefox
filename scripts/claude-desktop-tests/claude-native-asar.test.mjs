// Synthetic asar archives only: nothing here opens an installed app or a user profile.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { normalizeAsarPath, parseAsar, readAsarFile, replaceAsarFile } from "../claude-native-trial/asar.mjs";

const BLOCK = 16; // small blocks so one small file spans several
const bytes = value => Buffer.from(value, "utf8");
const sha = value => createHash("sha256").update(value).digest("hex");
const integrity = (content, blockSize = BLOCK) => {
  const blocks = [];
  for (let at = 0; at < content.length; at += blockSize) blocks.push(sha(content.subarray(at, at + blockSize)));
  if (!blocks.length) blocks.push(sha(content.subarray(0, 0)));
  return { algorithm: "SHA256", hash: sha(content), blockSize, blocks };
};

/** Builds an archive from { path, content } entries, with optional holes between them and out-of-band entries. */
function build(specs, { gap = 0, headerOverride } = {}) {
  const files = {};
  const body = [];
  let offset = 0;
  const placed = new Map();
  for (const spec of specs) {
    const parts = spec.path.split("/");
    let parent = files;
    for (const part of parts.slice(0, -1)) parent = (parent[part] ??= { files: {} }).files;
    const leaf = parent[parts.at(-1)] ??= {};
    if (spec.shareWith) {
      const twin = placed.get(spec.shareWith);
      leaf.size = twin.content.length;
      leaf.offset = twin.offset;
      leaf.integrity = integrity(twin.content, spec.blockSize);
      continue;
    }
    const content = spec.content === undefined ? undefined : Buffer.isBuffer(spec.content) ? spec.content : bytes(spec.content);
    leaf.size = content ? content.length : (spec.size ?? 0);
    if (spec.unpacked) leaf.unpacked = true;
    else if (spec.link !== undefined) leaf.link = spec.link;
    else {
      leaf.offset = String(offset);
      placed.set(spec.path, { offset: leaf.offset, content: content ?? Buffer.alloc(0) });
      if (content) body.push(content);
      offset += (content ? content.length : 0) + (spec.gapAfter ?? gap);
      if (spec.gapAfter ?? gap) body.push(Buffer.alloc(spec.gapAfter ?? gap));
    }
    if (spec.integrity !== false) leaf.integrity = integrity(content ?? Buffer.alloc(0), spec.blockSize);
    if (spec.executable) leaf.executable = true;
  }
  const headerText = headerOverride ?? JSON.stringify({ files });
  const jsonLength = Buffer.byteLength(headerText, "utf8");
  const headerSize = 8 + Math.ceil(jsonLength / 4) * 4;
  const headerBlock = Buffer.alloc(headerSize);
  headerBlock.writeUInt32LE(headerSize - 4, 0);
  headerBlock.writeUInt32LE(jsonLength, 4);
  headerBlock.write(headerText, 8, jsonLength, "utf8");
  return Buffer.concat([(() => { const h = Buffer.alloc(8); h.writeUInt32LE(4, 0); h.writeUInt32LE(headerSize, 4); return h; })(), headerBlock, ...body]);
}

const tree = archive => parseAsar(archive).header;
const bodyOf = archive => { const info = parseAsar(archive); return archive.subarray(info.bodyOffset); };

function rejects(buffer, message, path = "a.js") {
  assert.throws(() => readAsarFile(buffer, path), err => {
    assert.ok(err.name === "AsarError", `expected AsarError, got ${err.name}`);
    assert.match(err.message, message);
    return true;
  }, message);
}

test("header layout matches the asar format", () => {
  const archive = build([{ path: "a.js", content: "hello" }]);
  const info = parseAsar(archive);
  assert.equal(archive.readUInt32LE(0), 4);
  assert.equal(info.headerSize, archive.readUInt32LE(4));
  assert.equal(archive.readUInt32LE(8), info.headerSize - 4);
  assert.equal(archive.readUInt32LE(12), Buffer.byteLength(info.headerText, "utf8"));
  assert.equal(info.headerSize, 8 + Math.ceil(Buffer.byteLength(info.headerText, "utf8") / 4) * 4);
  assert.equal(info.bodyOffset, 8 + info.headerSize);
  assert.equal(info.bodyOffset + 5, archive.length);
  assert.equal(info.headerSha256, sha(info.headerText));
  assert.notEqual(info.headerSha256, sha(archive.subarray(8, 8 + info.headerSize)), "the hash is of the JSON text, not the padded block");
});

test("reads nested entries and normalizes separators", () => {
  const archive = build([
    { path: "index.js", content: "one" },
    { path: "vendor/deep/two.js", content: "two-bytes" },
  ]);
  assert.equal(readAsarFile(archive, "index.js").toString(), "one");
  assert.equal(readAsarFile(archive, "vendor/deep/two.js").toString(), "two-bytes");
  assert.equal(readAsarFile(archive, "vendor\\deep\\two.js").toString(), "two-bytes");
  assert.equal(normalizeAsarPath("a/b.js"), "a/b.js");
  assert.equal(normalizeAsarPath("a\\b.js"), "a/b.js");
  for (const unsafe of ["./a//b.js", "a//b.js", "./a.js", "a/./b.js", "a/../b.js", "a/", ""]) {
    assert.throws(() => normalizeAsarPath(unsafe), err => err.name === "AsarError", `should reject ${JSON.stringify(unsafe)}`);
  }
  const copy = readAsarFile(archive, "index.js");
  copy[0] = 0x5a;
  assert.equal(readAsarFile(archive, "index.js").toString(), "one", "reads hand back a copy");
});

test("rejects paths that are absent, escaped, or have no bytes in the archive", () => {
  const archive = build([
    { path: "packed.js", content: "x" },
    { path: "loose.js", content: "y", unpacked: true },
    { path: "alias.js", link: "packed.js" },
  ]);
  for (const bad of ["missing.js", "../packed.js", "a/../../packed.js", "/packed.js", "\\\\server\\share", "packed.js/", "", "loose.js/../packed.js"]) {
    assert.throws(() => readAsarFile(archive, bad), err => err.name === "AsarError", `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => readAsarFile(archive, "vendor"), err => err.name === "AsarError");
  assert.throws(() => readAsarFile(archive, "loose.js"), /unpacked/);
  assert.throws(() => readAsarFile(archive, "alias.js"), /symlink/);
  assert.throws(() => readAsarFile(archive, "vendor\u0000.js"), /control characters/);
  assert.throws(() => replaceAsarFile(archive, "vendor", bytes("z")), /not a file/);
  assert.throws(() => replaceAsarFile(archive, "loose.js", bytes("z")), /unpacked/);
  assert.throws(() => replaceAsarFile(archive, "alias.js", bytes("z")), /symlink/);
  assert.throws(() => replaceAsarFile(Buffer.alloc(0), "a.js", bytes("z")), /too small/);
  assert.throws(() => replaceAsarFile("not a buffer", "a.js"), /must be a Buffer/);
  assert.throws(() => replaceAsarFile(archive, "packed.js", "not a buffer"), /must be a Buffer/);
});

test("replacing with the same bytes reproduces the archive exactly", () => {
  const archive = build([
    { path: "a.js", content: "alpha" },
    { path: "dir/b.js", content: "bravo" },
    { path: "dir/c.js", content: "charlie" },
  ]);
  const { archive: out, headerSha256 } = replaceAsarFile(archive, "dir/b.js", readAsarFile(archive, "dir/b.js"));
  assert.equal(Buffer.compare(out, archive), 0);
  assert.equal(headerSha256, parseAsar(archive).headerSha256);
});

test("growing shifts only the entries that start after the target", () => {
  const archive = build([
    { path: "a.js", content: "aaa" },
    { path: "b.js", content: "bbbb", gapAfter: 7 },
    { path: "c.js", content: "cc" },
    { path: "d.js", content: "d" },
  ]);
  const before = tree(archive);
  const delta = 5;
  const { archive: out } = replaceAsarFile(archive, "b.js", bytes("b".repeat(4 + delta)));
  const after = tree(out);
  assert.equal(after.files["b.js"].size, 9);
  assert.deepEqual(
    { a: before.files["a.js"].offset, c: Number(before.files["c.js"].offset) + delta, d: Number(before.files["d.js"].offset) + delta },
    { a: after.files["a.js"].offset, c: Number(after.files["c.js"].offset), d: Number(after.files["d.js"].offset) },
  );
  assert.equal(typeof after.files["c.js"].offset, "string", "offsets stay decimal strings");
  assert.equal(out.length, archive.length + delta);
  assert.equal(readAsarFile(out, "b.js").toString(), "bbbbbbbbb");
  assert.equal(readAsarFile(out, "a.js").toString(), "aaa");
  assert.equal(readAsarFile(out, "c.js").toString(), "cc");
  assert.equal(readAsarFile(out, "d.js").toString(), "d");
  const oldBody = bodyOf(archive).toString("latin1");
  const newBody = bodyOf(out).toString("latin1");
  assert.equal(newBody.slice(0, 3), oldBody.slice(0, 3), "bytes before the target are untouched");
  assert.equal(newBody.slice(12 + delta), oldBody.slice(12), "bytes after the target are untouched, gap included");
});

test("shrinking keeps the tail and other integrity records intact", () => {
  const archive = build([
    { path: "a.js", content: "aaaaaa" },
    { path: "b.js", content: "bbbbbbbbbb" },
    { path: "c.js", content: "ccc" },
  ]);
  const { archive: out } = replaceAsarFile(archive, "a.js", bytes("xx"));
  assert.equal(out.length, archive.length - 4);
  assert.equal(Number(tree(out).files["b.js"].offset), 2);
  assert.deepEqual(tree(out).files["b.js"].integrity, tree(archive).files["b.js"].integrity, "untouched entries keep their integrity");
  assert.equal(readAsarFile(out, "a.js").toString(), "xx");
  assert.equal(readAsarFile(out, "b.js").toString(), "bbbbbbbbbb");
  assert.equal(readAsarFile(out, "c.js").toString(), "ccc");
});

test("target integrity is rebuilt, block size and algorithm preserved", () => {
  const original = bytes("0123456789abcdefghijklmnop");
  const archive = build([{ path: "a.js", content: original, blockSize: 8 }, { path: "b.js", content: "z" }]);
  assert.equal(tree(archive).files["a.js"].integrity.blocks.length, Math.ceil(original.length / 8));
  const replacement = bytes("short");
  const { archive: out } = replaceAsarFile(archive, "a.js", replacement);
  const node = tree(out).files["a.js"];
  assert.deepEqual(node.integrity, integrity(replacement, 8));
  assert.equal(node.integrity.blockSize, 8);
  assert.equal(node.integrity.algorithm, "SHA256");
  assert.equal(node.integrity.blocks.length, 1);
  const empty = replaceAsarFile(out, "a.js", Buffer.alloc(0)).archive;
  assert.deepEqual(tree(empty).files["a.js"].integrity, integrity(Buffer.alloc(0), 8));
  assert.equal(readAsarFile(empty, "a.js").length, 0);
  const grown = replaceAsarFile(empty, "a.js", bytes("x".repeat(40))).archive;
  assert.equal(tree(grown).files["a.js"].integrity.blocks.length, Math.ceil(40 / 8));
  assert.equal(readAsarFile(grown, "a.js").length, 40);
  assert.equal(readAsarFile(grown, "b.js").toString(), "z");
});

test("returned header hash is the hash of the new raw JSON header text", () => {
  const archive = build([{ path: "a.js", content: "aaa" }, { path: "b.js", content: "bbb" }]);
  const { archive: out, headerSha256 } = replaceAsarFile(archive, "a.js", bytes("longer than before"));
  const info = parseAsar(out);
  assert.equal(headerSha256, info.headerSha256);
  assert.equal(headerSha256, sha(out.toString("utf8", 16, 16 + out.readUInt32LE(12))));
  assert.notEqual(headerSha256, parseAsar(archive).headerSha256);
});

test("preserves entry extras and tolerates an odd-length JSON header", () => {
  let archive;
  for (let pad = 0; pad < 4; pad += 1) {
    archive = build([{ path: `run${"r".repeat(pad)}.js`, content: "echo", executable: true }, { path: "b.js", content: "bb" }]);
    if (Buffer.byteLength(parseAsar(archive).headerText, "utf8") % 4 !== 0) break;
  }
  assert.notEqual(Buffer.byteLength(parseAsar(archive).headerText, "utf8") % 4, 0, "the JSON needs zero padding");
  const runPath = Object.keys(tree(archive).files).find(name => name.startsWith("run"));
  const { archive: out } = replaceAsarFile(archive, runPath, bytes("echo hi"));
  assert.equal(tree(out).files[runPath].executable, true);
  assert.equal(readAsarFile(out, runPath).toString(), "echo hi");
  assert.equal(out.readUInt32LE(4) % 4, 0);
  assert.deepEqual([...out.subarray(16 + out.readUInt32LE(12), 8 + out.readUInt32LE(4))], [0, 0, 0, 0].slice(0, out.readUInt32LE(4) - 8 - out.readUInt32LE(12)), "padding stays zero");
});

test("rejects malformed or absurd headers", () => {
  const good = build([{ path: "a.js", content: "aaaa" }, { path: "b.js", content: "bbbb" }]);
  const poke = (at, value) => { const copy = Buffer.from(good); copy.writeUInt32LE(value, at); return copy; };
  rejects(poke(0, 5), /not an asar archive/);
  rejects(poke(4, 7), /implausible header size/);
  rejects(poke(4, 16), /payload size disagrees|JSON length/);
  rejects(poke(4, 0xffff0000), /implausible header size/);
  rejects(poke(8, 8), /payload size disagrees/);
  rejects(poke(12, good.readUInt32LE(12) + 4), /JSON length .* disagrees/);
  rejects(poke(12, good.readUInt32LE(12) + 1), /JSON length .* disagrees|not parseable/);
  rejects(poke(12, 0), /JSON length .* disagrees/);
  rejects(good.subarray(0, good.length - 4), /reads past the end/);
  rejects(Buffer.concat([good.subarray(0, 8), Buffer.alloc(4)]), /too small/);
  rejects(good.subarray(0, 20), /past the end of the archive/);
  const badJson = build([{ path: "a.js", content: "x" }], { headerOverride: "{not json" });
  rejects(badJson, /not parseable/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: "[1,2]" }), /not an object/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":[]}' }), /`files` is not an object/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":{"a.js":"x"}}' }), /not an object/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":{"a":{"files":{},"size":4,"offset":"0"}}}' }), /carries file bytes/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":{"a.js":{"size":1.5,"offset":"0"}}}' }), /invalid size/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":{"a.js":{"size":1,"offset":"-1"}}}' }), /invalid offset/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":{"a.js":{"size":1,"offset":"abc"}}}' }), /invalid offset/);
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: '{"files":{"a.js":{"size":1}}}' }), /no body offset/);
  rejects(build([{ path: "a.js", content: "aaaa" }], { headerOverride: '{"files":{"a.js":{"size":99,"offset":"0"}}}' }), /past the end of the archive/);
  rejects(build([{ path: "a.js", content: "aaaa" }], { headerOverride: '{"files":{"a.js":{"size":4,"offset":"99"}}}' }), /past the end of the archive/);
  rejects(build([{ path: "a.js", content: "aaaa" }, { path: "b.js", content: "bbbb" }], { headerOverride: '{"files":{"a.js":{"size":4,"offset":"0"},"b.js":{"size":4,"offset":"2"}}}' }), /overlaps/);
  let deep = `{"size":1,"offset":"0"}`;
  for (let level = 0; level < 70; level += 1) deep = `{"files":{"d${level}":${deep}}}`;
  rejects(build([{ path: "a.js", content: "x" }], { headerOverride: deep }), /too deeply/);
});

test("replacement survives repeated edits and re-parses", () => {
  let archive = build([{ path: "main.js", content: "one" }, { path: "vendor/x.js", content: "two" }, { path: "z.js", content: "three" }]);
  for (const text of ["replacement is much longer than the original", "0", "again, and longer this time by far"]) {
    const { archive: out, headerSha256 } = replaceAsarFile(archive, "main.js", bytes(text));
    assert.equal(headerSha256, parseAsar(out).headerSha256);
    assert.equal(readAsarFile(out, "main.js").toString(), text);
    assert.equal(readAsarFile(out, "vendor/x.js").toString(), "two");
    assert.equal(readAsarFile(out, "z.js").toString(), "three");
    archive = out;
  }
  assert.equal(readAsarFile(archive, "main.js").toString(), "again, and longer this time by far");
});

test("exact duplicate ranges are accepted and a partial overlap is not", () => {
  const archive = build([
    { path: "x/one.js", content: "shared-bytes" },
    { path: "x/two.js", shareWith: "x/one.js" },
    { path: "after.js", content: "tail" },
  ]);
  const info = parseAsar(archive);
  assert.equal(info.byPath.get("x/one.js").shared, true);
  assert.equal(info.byPath.get("x/two.js").shared, true);
  assert.equal(info.byPath.get("after.js").shared, undefined);
  assert.equal(readAsarFile(archive, "x/two.js").toString(), "shared-bytes");
  const header = (a, b) => `{"files":{"a.js":${a},"b.js":${b}}}`;
  const withHeader = text => build([{ path: "a.js", content: "aaaaaaaaaaaa" }], { headerOverride: text });
  rejects(withHeader(header('{"size":8,"offset":"0"}', '{"size":4,"offset":"0"}')), /overlaps/);
  rejects(withHeader(header('{"size":8,"offset":"0"}', '{"size":4,"offset":"4"}')), /overlaps/);
  rejects(withHeader(header('{"size":8,"offset":"0"}', '{"size":8,"offset":"2"}')), /overlaps/);
  rejects(withHeader(header('{"size":8,"offset":"0","integrity":{"hash":"1"}}', '{"size":8,"offset":"0","integrity":{"hash":"2"}}')), /integrity/);
  assert.equal(readAsarFile(withHeader(header('{"size":8,"offset":"0"}', '{"size":8,"offset":"0"}')), "b.js").toString(), "aaaaaaaa");
  assert.equal(readAsarFile(withHeader(header('{"size":8,"offset":"0"}', '{"size":0,"offset":"3"}')), "b.js").length, 0, "an empty file may sit anywhere");
});

test("replacing a shared target appends and leaves the other entry's bytes alone", () => {
  const archive = build([
    { path: "first.js", content: "keep-me" },
    { path: "twin.js", shareWith: "first.js" },
    { path: "last.js", content: "zz" },
  ]);
  const replacement = bytes("a much longer replacement");
  for (const target of ["first.js", "twin.js"]) {
    const other = target === "first.js" ? "twin.js" : "first.js";
    const { archive: out, headerSha256 } = replaceAsarFile(archive, target, replacement);
    assert.equal(headerSha256, parseAsar(out).headerSha256);
    assert.equal(readAsarFile(out, target).toString(), replacement.toString());
    assert.equal(readAsarFile(out, other).toString(), "keep-me");
    assert.equal(readAsarFile(out, "last.js").toString(), "zz");
    assert.equal(bodyOf(out).length, bodyOf(archive).length + replacement.length);
    assert.equal(bodyOf(out).subarray(0, bodyOf(archive).length).compare(bodyOf(archive)), 0, "existing body bytes are untouched");
    assert.deepEqual(tree(out).files[other], tree(archive).files[other]);
    assert.deepEqual(tree(out).files[target].integrity, integrity(replacement));
    assert.equal(typeof tree(out).files[target].offset, "string");
    assert.equal(replaceAsarFile(out, target, bytes("again")).archive.length > 0, true, "the unshared target can be edited again");
  }
});

const REAL_ASAR = "/Applications/Claude.app/Contents/Resources/app.asar";
test("real Claude app.asar (read-only): dedup ranges parse, main reads and round-trips", { skip: !existsSync(REAL_ASAR) }, () => {
  const archive = readFileSync(REAL_ASAR);
  const info = parseAsar(archive);
  const twin = ".vite/build/index.chunk-Bwjm9goP.js";
  const other = ".vite/build/index.chunk-B8OYgHjc.js";
  if (info.byPath.has(twin) && info.byPath.has(other)) {
    assert.equal(info.byPath.get(twin).offset, info.byPath.get(other).offset);
    assert.equal(info.byPath.get(twin).shared, true);
    assert.ok(readAsarFile(archive, twin).equals(readAsarFile(archive, other)));
    const { archive: out } = replaceAsarFile(archive, twin, bytes("// changed\n"));
    assert.ok(readAsarFile(out, other).equals(readAsarFile(archive, other)), "the twin keeps its original bytes");
    assert.equal(readAsarFile(out, twin).toString(), "// changed\n");
  }
  const main = readAsarFile(archive, ".vite/build/index.pre.js");
  assert.ok(main.length > 100_000);
  assert.equal(info.byPath.get(".vite/build/index.pre.js").shared, undefined);
  const { archive: same, headerSha256 } = replaceAsarFile(archive, ".vite/build/index.pre.js", main);
  assert.equal(headerSha256, info.headerSha256);
  assert.ok(same.equals(archive), "an identical replacement reproduces the archive byte for byte");
  const edited = replaceAsarFile(archive, ".vite/build/index.pre.js", Buffer.concat([bytes('"use strict";\n'), main])).archive;
  assert.ok(readAsarFile(edited, ".vite/build/index.pre.js").subarray(14).equals(main));
  assert.ok(info.packed.filter(e => e.path !== ".vite/build/index.pre.js").every(e => readAsarFile(edited, e.path).length === e.node.size));
});

test("replacing an empty entry parked inside another entry's range leaves that owner intact", () => {
  const header = '{"files":{"owner.js":{"size":8,"offset":"0"},"empty.js":{"size":0,"offset":"3"},"edge.js":{"size":0,"offset":"8"}}}';
  const archive = build([{ path: "owner.js", content: "aaaaaaaa" }], { headerOverride: header });
  assert.equal(readAsarFile(archive, "empty.js").length, 0);
  const replacement = bytes("hello");
  const { archive: out, headerSha256 } = replaceAsarFile(archive, "empty.js", replacement);
  assert.equal(headerSha256, parseAsar(out).headerSha256);
  assert.equal(readAsarFile(out, "owner.js").toString(), "aaaaaaaa", "the owner's bytes are not spliced into");
  assert.equal(readAsarFile(out, "empty.js").toString(), "hello");
  assert.equal(readAsarFile(out, "edge.js").length, 0);
  assert.equal(tree(out).files["empty.js"].offset, "8", "the replacement is appended after the existing body");
  assert.equal(tree(out).files["owner.js"].offset, "0");
  assert.equal(bodyOf(out).length, bodyOf(archive).length + replacement.length);
  assert.equal(bodyOf(out).subarray(0, 8).toString(), "aaaaaaaa");
  // Replacing the owner afterwards must keep every empty entry inside the new archive and the result parseable.
  const shrunk = replaceAsarFile(archive, "owner.js", bytes("xx")).archive;
  assert.equal(readAsarFile(shrunk, "owner.js").toString(), "xx");
  assert.equal(readAsarFile(shrunk, "empty.js").length, 0);
  assert.equal(readAsarFile(shrunk, "edge.js").length, 0);
  assert.ok(Number(tree(shrunk).files["empty.js"].offset) <= 2, "an empty entry is clamped to the owner's new end");
  const grown = replaceAsarFile(archive, "owner.js", bytes("y".repeat(12))).archive;
  assert.equal(readAsarFile(grown, "owner.js").toString(), "y".repeat(12));
  assert.equal(readAsarFile(grown, "empty.js").length, 0);
  assert.equal(readAsarFile(grown, "edge.js").length, 0);
});
