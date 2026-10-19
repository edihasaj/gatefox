import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { extractArchive, verifyChecksummedTree } from "../app-updates/archive.js";
import type { Command } from "../app-updates/types.js";

const exec = promisify(execFile);
const root = "Harness Gateway.app";
const tarRoot = "harness-gateway-1.2.3-macos-arm64";
const crc = (bytes: Buffer): number => {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
};
type ZipEntry = { name: string; data?: Buffer; mode?: number; expanded?: number; extra?: Buffer };
function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = entry.data || Buffer.alloc(0), extra = entry.extra || Buffer.alloc(0), directory = entry.name.endsWith("/");
    const size = entry.expanded ?? data.length, checksum = crc(data), mode = entry.mode ?? (directory ? 0o40755 : 0o100644);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28); local.push(header, name, extra, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28); record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(mode * 2 ** 16, 38); record.writeUInt32LE(offset, 42); central.push(record, name, extra); offset += header.length + name.length + extra.length + data.length;
  }
  const body = Buffer.concat(local), directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}
type TarEntry = { name: string; type?: number; data?: Buffer; mode?: number };
function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data || Buffer.alloc(0), header = Buffer.alloc(512), name = Buffer.from(entry.name), type = entry.type ?? 48;
    name.copy(header); header.write((entry.mode ?? (type === 53 ? 0o755 : 0o644)).toString(8).padStart(7, "0") + "\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header[156] = type; header.write("ustar\0", 257); header.write("00", 263); header.fill(32, 148, 156);
    let sum = 0; for (const byte of header) sum += byte; header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const normalZip = (): ZipEntry[] => [{ name: `${root}/` }, { name: `${root}/Contents/` }, { name: `${root}/Contents/Info.plist`, data: Buffer.from("ok") }];
const noop: { calls: number; command: Command } = { calls: 0, command: async () => { noop.calls++; return { code: 0, stdout: "", stderr: "" }; } };
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-archive-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function rejectsBeforeExtract(kind: "zip" | "tar", bytes: Buffer, topLevel = root): Promise<void> {
  await fixture(async directory => {
    const archive = join(directory, "asset"), destination = join(directory, "out"); await writeFile(archive, bytes); noop.calls = 0;
    await assert.rejects(extractArchive(kind, archive, destination, topLevel, noop.command), /unsafe archive/);
    assert.equal(noop.calls, 0); await assert.rejects(stat(destination));
  });
}

test("ZIP traversal, duplicate macOS-normalized names, links, inflated headers, and forged AppleDouble fail before extraction", async () => {
  await rejectsBeforeExtract("zip", zip([{ name: `${root}/` }, { name: "../escaped", data: Buffer.from("x") }]));
  await rejectsBeforeExtract("zip", zip([...normalZip(), { name: `${root}/A`, data: Buffer.from("a") }, { name: `${root}/a`, data: Buffer.from("b") }]));
  await rejectsBeforeExtract("zip", zip([{ name: `${root}/` }, { name: `${root}/link`, data: Buffer.from("target"), mode: 0o120777 }]));
  await rejectsBeforeExtract("zip", zip([...normalZip(), { name: `${root}/path-override`, data: Buffer.from("x"), extra: Buffer.from([0x75, 0x70, 0, 0]) }]));
  await rejectsBeforeExtract("zip", zip([{ name: `${root}/` }, { name: `${root}/empty`, expanded: 1_500 * 1024 * 1024 + 1 }]));
  await rejectsBeforeExtract("zip", zip([...normalZip(), { name: "__MACOSX/" }, { name: `__MACOSX/${root}/` },
    { name: `__MACOSX/${root}/Contents/` }, { name: `__MACOSX/${root}/Contents/._Info.plist`, data: Buffer.from("forged") }]));
});

test("tar links, traversal, and PAX path overrides fail before extraction", async () => {
  await rejectsBeforeExtract("tar", tar([{ name: `${tarRoot}/`, type: 53 }, { name: `${tarRoot}/link`, type: 49 }]), tarRoot);
  await rejectsBeforeExtract("tar", tar([{ name: `${tarRoot}/`, type: 53 }, { name: "../escaped", data: Buffer.from("x") }]), tarRoot);
  const path = Buffer.from("path=../escaped\n"), pax = Buffer.from(`${path.length + String(path.length).length + 1} ${path}`);
  await rejectsBeforeExtract("tar", tar([{ name: "PaxHeader", type: 120, data: pax }, { name: `${tarRoot}/`, type: 53 }]), tarRoot);
});

test("empty ZIP files remain valid and complete manifest trees are hashed without loading payloads", async () => fixture(async directory => {
  const archive = join(directory, "app.zip"), destination = join(directory, "out"); await writeFile(archive, zip([...normalZip(), { name: `${root}/Contents/empty` }]));
  const command: Command = async (_file, args) => {
    await exec(process.platform === "darwin" ? "/usr/bin/ditto" : "/usr/bin/unzip",
      process.platform === "darwin" ? args : ["-q", archive, "-d", destination]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const extracted = await extractArchive("zip", archive, destination, root, command);
  assert.equal((await readFile(join(extracted, "Contents", "empty"))).length, 0);
  const backend = join(directory, tarRoot); await mkdir(join(backend, "package"), { recursive: true });
  await writeFile(join(backend, "package", "release.json"), "payload"); const hash = (await import("node:crypto")).createHash("sha256").update("payload").digest("hex");
  await writeFile(join(backend, "checksums.txt"), `${hash}  package/release.json\n`); await verifyChecksummedTree(backend);
  await writeFile(join(backend, "unexpected"), "no"); await assert.rejects(verifyChecksummedTree(backend), /unsafe archive/);
}));

test("real ditto app ZIP with root, nested-directory, and file xattrs round-trips", { skip: process.platform !== "darwin" }, async () => fixture(async directory => {
  const app = join(directory, root), archive = join(directory, "signed.zip"), destination = join(directory, "out");
  await mkdir(join(app, "Contents", "Resources"), { recursive: true }); await writeFile(join(app, "Contents", "Resources", "Info.plist"), "ok");
  for (const path of [app, join(app, "Contents"), join(app, "Contents", "Resources", "Info.plist")]) await exec("/usr/bin/xattr", ["-w", "com.edihasaj.fixture", "proof", path]);
  await exec("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
  const command: Command = async (file, args) => { await exec(file, args); return { code: 0, stdout: "", stderr: "" }; };
  assert.equal(await extractArchive("zip", archive, destination, root, command), join(destination, root));
}));

test("a canonical BSD tar backend archive extracts with executable files preserved", { skip: process.platform !== "darwin" }, async () => fixture(async directory => {
  const backend = join(directory, tarRoot), archive = join(directory, "backend.tar.gz"), destination = join(directory, "out");
  await mkdir(join(backend, "package"), { recursive: true }); await writeFile(join(backend, "install"), "x", { mode: 0o700 }); await writeFile(join(backend, "package", "release.json"), "{}");
  await exec("/usr/bin/tar", ["-czf", archive, "-C", directory, tarRoot]);
  const command: Command = async (file, args) => { await exec(file, args); return { code: 0, stdout: "", stderr: "" }; };
  const extracted = await extractArchive("tar", archive, destination, tarRoot, command);
  assert.ok((await stat(join(extracted, "install"))).mode & 0o100);
}));
