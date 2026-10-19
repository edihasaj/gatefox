import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createGunzip, createInflateRaw } from "node:zlib";
import type { Command } from "./types.js";
import { contained, readProtected, safeAncestors } from "./private-fs.js";

const maximumBytes = 1_500 * 1024 * 1024;
const maximumEntries = 100_000;
const maximumName = 4096;
const maximumMetadata = 16 * 1024;
const maximumCentralDirectory = 32 * 1024 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;
const owner = process.getuid?.();

type Entry = { name: string; directory: boolean; metadata: boolean };
type CheckedArchive = { entries: Map<string, Entry>; metadata: Map<string, Entry> };

function unsafe(): never { throw new Error("unsafe archive"); }
function safeName(value: string, trailing = false): string {
  const name = trailing && value.endsWith("/") ? value.slice(0, -1) : value;
  if (!name || name.length > maximumName || name.startsWith("/") || /[\\\0-\x1f\x7f]/.test(name) ||
    name.split("/").some(part => !part || part === "." || part === "..")) unsafe();
  return name;
}
function folded(name: string): string { return name.normalize("NFC").toLocaleLowerCase("en-US"); }
function appleDouble(name: string): boolean { return basename(name).startsWith("._"); }
function appleDoubleBytes(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.readUInt32BE(0) === 0x00051607 && bytes.readUInt32BE(4) === 0x00020000;
}
function insert(entries: Map<string, Entry>, foldedNames: Set<string>, entry: Entry): void {
  const key = folded(entry.name); if (foldedNames.has(key)) unsafe();
  foldedNames.add(key); entries.set(entry.name, entry);
}
function validateTree(all: Map<string, Entry>, topLevel: string, zip: boolean): CheckedArchive {
  const entries = new Map<string, Entry>(), metadata = new Map<string, Entry>();
  for (const entry of all.values()) (entry.metadata ? metadata : entries).set(entry.name, entry);
  if (!entries.get(topLevel)?.directory) unsafe();
  for (const entry of entries.values()) {
    if ((entry.name !== topLevel && !entry.name.startsWith(`${topLevel}/`)) ||
      (entry.name !== topLevel && !entries.get(posix.dirname(entry.name))?.directory)) unsafe();
  }
  for (const entry of metadata.values()) {
    if (!zip) {
      if (entry.directory || !appleDouble(entry.name)) unsafe();
      const companion = join(posix.dirname(entry.name), basename(entry.name).slice(2));
      if (!entries.get(companion)) unsafe();
      continue;
    }
    if (entry.name === "__MACOSX") { if (!entry.directory) unsafe(); continue; }
    const metadataRoot = `__MACOSX/${topLevel}`;
    if (entry.name !== metadataRoot && !entry.name.startsWith(`${metadataRoot}/`)) unsafe();
    if (entry.directory) continue;
    if (!appleDouble(entry.name)) unsafe();
    const companion = entry.name.slice("__MACOSX/".length).replace(/(^|\/)\._/, "$1");
    if (!entries.get(companion)) unsafe();
  }
  return { entries, metadata };
}
async function openedArchive(path: string): Promise<{ file: Awaited<ReturnType<typeof open>>; size: number }> {
  await safeAncestors(dirname(path));
  const file = await open(path, constants.O_RDONLY | noFollow).catch(unsafe);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes || info.nlink !== 1) unsafe();
    return { file, size: info.size };
  } catch (error) { await file.close(); throw error; }
}
async function readAt(file: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length); const { bytesRead } = await file.read(bytes, 0, length, offset);
  if (bytesRead !== length) unsafe();
  return bytes;
}
function u16(bytes: Buffer, offset: number): number { return bytes.readUInt16LE(offset); }
function u32(bytes: Buffer, offset: number): number { return bytes.readUInt32LE(offset); }
function safeZipExtra(bytes: Buffer, lengths: number[]): void {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) unsafe();
    const id = u16(bytes, offset), length = u16(bytes, offset + 2); offset += 4;
    // ditto writes only the legacy Unix timestamp field (0x5855): eight bytes
    // in the central record and twelve in its local header. Other extra fields
    // can carry a second name, Unix type, or ZIP64 sizes, so they are not input.
    if (id !== 0x5855 || !lengths.includes(length) || offset + length > bytes.length) unsafe();
    offset += length;
  }
}
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; table[i] = value >>> 0; }
  return table;
})();
function crc32(value: number, bytes: Buffer): number {
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ value >>> 8;
  return value >>> 0;
}
async function verifyZipPayload(fd: number, start: number, size: number, deflated: boolean, expanded: number, expectedCrc: number,
  metadata: boolean): Promise<void> {
  if (!size) {
    if (deflated || expanded || expectedCrc || metadata) unsafe();
    return;
  }
  let total = 0, crc = 0xffffffff, prefix = Buffer.alloc(0);
  const source = createReadStream("", { fd, autoClose: false, start, end: start + size - 1 });
  const stream = deflated ? source.pipe(createInflateRaw()) : source;
  try {
    for await (const item of stream) {
      const bytes = Buffer.from(item); total += bytes.length; if (total > expanded || total > maximumBytes) unsafe();
      crc = crc32(crc, bytes); if (metadata && prefix.length < 8) prefix = Buffer.concat([prefix, bytes.subarray(0, 8 - prefix.length)]);
    }
  } catch { unsafe(); }
  if (total !== expanded || (crc ^ 0xffffffff) >>> 0 !== expectedCrc || metadata && !appleDoubleBytes(prefix)) unsafe();
}
async function preflightZip(path: string, topLevel: string): Promise<CheckedArchive> {
  const archive = await openedArchive(path); const { file, size } = archive;
  try {
    const tailSize = Math.min(size, 65_557), tail = await readAt(file, size - tailSize, tailSize); let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + u16(tail, index + 20) === tail.length) { eocd = index; break; }
    }
    if (eocd < 0 || u16(tail, eocd + 4) || u16(tail, eocd + 6)) unsafe();
    const count = u16(tail, eocd + 10), countOnDisk = u16(tail, eocd + 8), centralSize = u32(tail, eocd + 12), centralOffset = u32(tail, eocd + 16);
    if (!count || count !== countOnDisk || count > maximumEntries || count === 0xffff || centralSize > maximumCentralDirectory || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      centralOffset + centralSize > size - tailSize + eocd) unsafe();
    const central = await readAt(file, centralOffset, centralSize); let offset = 0, expandedTotal = 0;
    const entries = new Map<string, Entry>(), names = new Set<string>(), spans: Array<[number, number]> = [];
    const payloads: Array<[number, number, boolean, number, number, boolean]> = [];
    for (let index = 0; index < count; index++) {
      if (offset + 46 > central.length || u32(central, offset) !== 0x02014b50) unsafe();
      const madeBy = u16(central, offset + 4), flags = u16(central, offset + 8), method = u16(central, offset + 10), descriptor = !!(flags & 8);
      const crc = u32(central, offset + 16), compressed = u32(central, offset + 20), expanded = u32(central, offset + 24);
      const nameSize = u16(central, offset + 28), extraSize = u16(central, offset + 30), commentSize = u16(central, offset + 32);
      const disk = u16(central, offset + 34), attributes = u32(central, offset + 38), localOffset = u32(central, offset + 42);
      const end = offset + 46 + nameSize + extraSize + commentSize;
      if (end > central.length || extraSize > maximumMetadata || commentSize > maximumMetadata || disk || flags & 0x2041 || ![0, 8].includes(method) || compressed > maximumBytes || expanded > maximumBytes ||
        compressed === 0xffffffff || expanded === 0xffffffff || localOffset === 0xffffffff) unsafe();
      safeZipExtra(central.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize), [8]);
      let raw: string; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(central.subarray(offset + 46, offset + 46 + nameSize)); } catch { unsafe(); }
      const directory = raw.endsWith("/"), name = safeName(raw, directory), mode = madeBy >>> 8 === 3 ? attributes >>> 16 : 0, type = mode & 0o170000;
      const metadata = name === "__MACOSX" || name.startsWith("__MACOSX/");
      if ((!metadata || !directory) && mode & 0o7022 || type && type !== (directory ? 0o040000 : 0o100000) || directory && expanded) unsafe();
      if (metadata && !(directory || appleDouble(name) && expanded <= maximumMetadata)) unsafe();
      expandedTotal += expanded; if (expandedTotal > maximumBytes) unsafe();
      const local = await readAt(file, localOffset, 30);
      if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== flags || u16(local, 8) !== method ||
        (!descriptor && (u32(local, 14) !== crc || u32(local, 18) !== compressed || u32(local, 22) !== expanded)) ||
        (descriptor && (u32(local, 14) || u32(local, 18) || u32(local, 22)))) unsafe();
      const localNameSize = u16(local, 26), localExtraSize = u16(local, 28), localName = await readAt(file, localOffset + 30, localNameSize);
      if (localExtraSize > maximumMetadata) unsafe();
      if (!localName.equals(central.subarray(offset + 46, offset + 46 + nameSize))) unsafe();
      safeZipExtra(await readAt(file, localOffset + 30 + localNameSize, localExtraSize), [12]);
      const dataStart = localOffset + 30 + localNameSize + localExtraSize, dataEnd = dataStart + compressed;
      let archiveEnd = dataEnd;
      if (descriptor) {
        const marker = await readAt(file, dataEnd, 4);
        const signed = u32(marker, 0) === 0x08074b50, data = await readAt(file, dataEnd + (signed ? 4 : 0), 12);
        if (u32(data, 0) !== crc || u32(data, 4) !== compressed || u32(data, 8) !== expanded) unsafe();
        archiveEnd += signed ? 16 : 12;
      }
      if (archiveEnd > centralOffset) unsafe();
      spans.push([localOffset, archiveEnd]); insert(entries, names, { name, directory, metadata });
      if (!directory) payloads.push([dataStart, compressed, method === 8, expanded, crc, metadata && appleDouble(name)]);
      offset = end;
    }
    if (offset !== central.length) unsafe();
    spans.sort((a, b) => a[0] - b[0]); if (spans.some((span, index) => index && span[0] < spans[index - 1]![1])) unsafe();
    for (const [start, compressed, deflated, expanded, crc, metadata] of payloads) {
      await verifyZipPayload(file.fd, start, compressed, deflated, expanded, crc, metadata);
    }
    return validateTree(entries, topLevel, true);
  } finally { await file.close(); }
}
function tarNumber(bytes: Buffer): number {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim(); if (!/^[0-7]+$/.test(text)) unsafe();
  const value = Number.parseInt(text, 8); if (!Number.isSafeInteger(value)) unsafe(); return value;
}
function tarText(bytes: Buffer): string {
  const zero = bytes.indexOf(0), used = zero < 0 ? bytes : bytes.subarray(0, zero);
  if (zero >= 0 && !bytes.subarray(zero).every(value => value === 0)) unsafe();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(used); } catch { unsafe(); }
}
function tarHeader(bytes: Buffer): { name: string; type: number; size: number; mode: number } {
  const supplied = tarNumber(bytes.subarray(148, 156)), actual = bytes.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
  if (supplied !== actual) unsafe();
  const type = bytes[156] || 48, base = tarText(bytes.subarray(0, 100)), prefix = tarText(bytes.subarray(345, 500));
  const size = tarNumber(bytes.subarray(124, 136)), mode = tarNumber(bytes.subarray(100, 108));
  if (mode & 0o7022 || size > maximumBytes || type === 53 && size) unsafe();
  return { name: safeName(prefix ? `${prefix}/${base}` : base, type === 53), type, size, mode };
}
function validatePax(bytes: Buffer): void {
  const keys = new Set<string>(); let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset); if (space < offset) unsafe();
    const lengthText = bytes.subarray(offset, space).toString("ascii"); if (!/^[1-9]\d*$/.test(lengthText)) unsafe();
    const length = Number(lengthText), end = offset + length; if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) unsafe();
    const pair = bytes.subarray(space + 1, end - 1), equal = pair.indexOf(61); if (equal < 1) unsafe();
    const key = pair.subarray(0, equal).toString("ascii"), value = pair.subarray(equal + 1).toString("ascii");
    if (keys.has(key) || !["mtime", "LIBARCHIVE.xattr.com.apple.provenance", "SCHILY.xattr.com.apple.provenance"].includes(key) ||
      value.length > maximumMetadata || /[\0-\x1f\x7f]/.test(key) || key === "mtime" && !/^-?\d+(?:\.\d+)?$/.test(value)) unsafe();
    keys.add(key); offset = end;
  }
}
async function preflightTar(path: string, topLevel: string): Promise<CheckedArchive> {
  const archive = await openedArchive(path); const { file } = archive;
  const entries = new Map<string, Entry>(), names = new Set<string>();
  let output = 0, count = 0, zeros = 0, ended = false, pendingPax = false, buffer = Buffer.alloc(0);
  let state: { header: ReturnType<typeof tarHeader>; remaining: number; padding: number; data: Buffer[] } | undefined;
  try {
    for await (const item of createReadStream("", { fd: file.fd, autoClose: false }).pipe(createGunzip())) {
      const chunk = Buffer.from(item); output += chunk.length; if (output > maximumBytes || ended && chunk.some(byte => byte)) unsafe();
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (!state) {
          if (buffer.length < 512) break;
          const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
          if (header.every(byte => byte === 0)) { ended = true; zeros++; continue; }
          if (ended || ++count > maximumEntries) unsafe();
          const parsed = tarHeader(header);
          if (![48, 53, 120].includes(parsed.type) || parsed.type === 120 && (pendingPax || parsed.size > maximumMetadata) ||
            appleDouble(parsed.name) && parsed.size > maximumMetadata) unsafe();
          state = { header: parsed, remaining: parsed.size, padding: (512 - parsed.size % 512) % 512, data: [] };
        }
        const amount = Math.min(buffer.length, state.remaining);
        if (amount) {
          const data = buffer.subarray(0, amount); buffer = buffer.subarray(amount); state.remaining -= amount;
          if (state.header.type === 120 || appleDouble(state.header.name)) state.data.push(data);
        }
        if (state.remaining || buffer.length < state.padding) break;
        buffer = buffer.subarray(state.padding);
        const complete = state; state = undefined;
        if (complete.header.type === 120) { validatePax(Buffer.concat(complete.data)); pendingPax = true; continue; }
        if (appleDouble(complete.header.name) && !appleDoubleBytes(Buffer.concat(complete.data))) unsafe();
        insert(entries, names, { name: complete.header.name, directory: complete.header.type === 53, metadata: appleDouble(complete.header.name) });
        pendingPax = false;
      }
    }
  } catch { unsafe(); }
  finally { await file.close(); }
  if (buffer.length || state || !ended || zeros < 2 || pendingPax) unsafe();
  return validateTree(entries, topLevel, false);
}
async function privateEmptyDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) unsafe();
  await safeAncestors(dirname(path));
  const prior = await lstat(path).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unsafe());
  if (prior) unsafe();
  await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || info.mode & 0o077) unsafe();
}
async function validateExtracted(destination: string, topLevel: string, checked: CheckedArchive): Promise<void> {
  const visit = async (path: string, prefix = ""): Promise<void> => {
    const info = await lstat(path);
    const metadata = checked.metadata.get(prefix);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1 || info.uid !== owner && info.uid !== 0 ||
      ((!metadata || !metadata.directory) && info.mode & 0o7022)) unsafe();
    if (prefix) {
      const entry = checked.entries.get(prefix) || checked.metadata.get(prefix);
      if (!entry || entry.directory !== info.isDirectory()) unsafe();
    }
    if (info.isDirectory()) for (const name of await readdir(path)) {
      safeName(name); const child = prefix ? `${prefix}/${name}` : name;
      if (!contained(destination, resolve(path, name))) unsafe();
      await visit(join(path, name), child);
    }
  };
  await visit(destination);
  if (!checked.entries.get(topLevel)?.directory) unsafe();
}

/** Validates binary headers, compressed payloads, sizes, names, and types before extraction. */
export async function extractArchive(kind: "zip" | "tar", archive: string, destination: string, topLevel: string, command: Command): Promise<string> {
  const root = safeName(topLevel);
  const checked = kind === "zip" ? await preflightZip(archive, root) : await preflightTar(archive, root);
  await privateEmptyDirectory(destination);
  const result = await command(kind === "zip" ? "/usr/bin/ditto" : "/usr/bin/tar",
    kind === "zip" ? ["-x", "-k", archive, destination] : ["-xzf", archive, "-C", destination, "--no-same-owner"],
    { timeoutMs: 180_000, stdoutLimit: 64 * 1024 });
  if (result.code !== 0) unsafe();
  await validateExtracted(destination, root, checked);
  return join(destination, root);
}

/** Verifies every regular backend payload file before the downloaded installer can run. */
export async function verifyChecksummedTree(root: string): Promise<void> {
  const manifest = await readProtected(join(root, "checksums.txt"), 1024 * 1024); if (!manifest) unsafe();
  const expected = new Map<string, string>();
  const expectedNames = new Set<string>();
  for (const line of new TextDecoder("utf-8", { fatal: true }).decode(manifest).split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line); if (!match) unsafe();
    const name = safeName(match[2]!); if (name === "checksums.txt" || expected.has(name) || expectedNames.has(folded(name))) unsafe();
    expectedNames.add(folded(name)); expected.set(name, match[1]!);
  }
  if (!expected.size) unsafe();
  const actual = new Map<string, string>();
  const actualNames = new Set<string>();
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== owner && directoryInfo.uid !== 0 || directoryInfo.mode & 0o7022) unsafe();
    for (const name of await readdir(directory)) {
      safeName(name); const relativeName = prefix ? `${prefix}/${name}` : name, path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink() || info.uid !== owner && info.uid !== 0 || info.mode & 0o7022) unsafe();
      if (info.isDirectory()) await walk(path, relativeName);
      else if (!info.isFile()) unsafe();
      else if (relativeName !== "checksums.txt") {
        if (appleDouble(relativeName)) {
          if (info.size > maximumMetadata || info.nlink !== 1) unsafe();
          const file = await open(path, constants.O_RDONLY | noFollow);
          try {
            const bytes = Buffer.alloc(8); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            if (bytesRead !== 8 || !appleDoubleBytes(bytes)) unsafe();
          } finally { await file.close(); }
          const companion = join(dirname(path), basename(path).slice(2)), companionInfo = await lstat(companion).catch(unsafe);
          if (!companionInfo || companionInfo.isSymbolicLink() || !companionInfo.isFile() && !companionInfo.isDirectory()) unsafe();
          continue;
        }
        if (info.size > maximumBytes || info.nlink !== 1 || actualNames.has(folded(relativeName))) unsafe();
        const file = await open(path, constants.O_RDONLY | noFollow);
        try {
          const digest = createHash("sha256");
          for await (const bytes of file.createReadStream({ autoClose: false })) digest.update(bytes);
          actualNames.add(folded(relativeName)); actual.set(relativeName, digest.digest("hex"));
        } finally { await file.close(); }
      }
    }
  };
  await walk(root);
  if (actual.size !== expected.size || [...expected].some(([name, digest]) => actual.get(name) !== digest)) unsafe();
}
