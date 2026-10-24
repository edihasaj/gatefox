// Bounded Node builtins only: read one file out of an asar archive, or replace that file's bytes in a copy of the
// archive. Verified against the official Claude.app `app.asar` header (500 packed files, 8 unpacked, gaps between
// entries, 4 MiB integrity blocks). Format: uint32LE 4, uint32LE headerSize, then a header block of headerSize bytes
// holding uint32LE headerSize-4, uint32LE jsonLength, the JSON text, and zero padding to a multiple of 4. The body
// starts at 8 + headerSize, and every entry's `offset` is relative to that body, so header growth never moves them.
import { createHash } from "node:crypto";

const ALIGN = 4;
const MAGIC = 4;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_PATH_BYTES = 4096;
const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;

export class AsarError extends Error {
  constructor(message) {
    super(`asar: ${message}`);
    this.name = "AsarError";
    this.code = "ERR_ASAR";
  }
}

const roundUp = (value, align) => Math.ceil(value / align) * align;
const sha256Text = text => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Bytes = bytes => createHash("sha256").update(bytes).digest("hex");

function digestWith(algorithm, bytes) {
  try {
    return createHash(algorithm).update(bytes).digest("hex");
  } catch {
    throw new AsarError(`unsupported integrity algorithm ${JSON.stringify(algorithm)}`);
  }
}

function readU32(buffer, at, what) {
  if (at + 4 > buffer.length) throw new AsarError(`truncated archive: cannot read ${what}`);
  return buffer.readUInt32LE(at);
}

/** Split a caller-supplied path into archive keys, rejecting anything that could leave the archive root. */
export function normalizeAsarPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) throw new AsarError("path must be a non-empty string");
  if (Buffer.byteLength(relativePath, "utf8") > MAX_PATH_BYTES) throw new AsarError("path is too long");
  if (/[\u0000-\u001f]/.test(relativePath)) throw new AsarError("path contains control characters");
  if (relativePath[0] === "/" || relativePath[0] === "\\") throw new AsarError("path must be relative to the archive root");
  const segments = relativePath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === "" || segment === "." ) throw new AsarError(`path has an empty segment: ${JSON.stringify(relativePath)}`);
    if (segment === "..") throw new AsarError(`path traverses out of the archive: ${JSON.stringify(relativePath)}`);
  }
  return segments.join("/");
}

function walkFiles(files, prefix, found, depth) {
  if (depth > 64) throw new AsarError("header nests directories too deeply");
  for (const [name, node] of Object.entries(files)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new AsarError(`header entry ${JSON.stringify(prefix + name)} is not an object`);
    if (found.size + 1 > MAX_ENTRIES) throw new AsarError("header lists too many entries");
    if (node.files) {
      if (node.size !== undefined || node.offset !== undefined) throw new AsarError(`directory ${JSON.stringify(prefix + name)} also carries file bytes`);
      if (!node.link) walkFiles(node.files, `${prefix + name}/`, found, depth + 1);
    } else {
      found.set(`${prefix}${name}`, node);
    }
  }
}

/**
 * Parse and validate an archive. Returns the header object and its raw JSON text, the body offset, every file entry by
 * normalized path, and the packed entries as byte ranges (exact duplicate ranges are flagged `shared`; partial overlap throws). Throws on a malformed or absurd header.
 */
export function parseAsar(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new AsarError("archive must be a Buffer");
  if (buffer.length < 16) throw new AsarError("archive is too small to hold a header");
  if (readU32(buffer, 0, "magic") !== MAGIC) throw new AsarError("not an asar archive (magic is not 4)");
  const headerSize = readU32(buffer, 4, "header size");
  if (headerSize < 12 || headerSize % ALIGN !== 0 || headerSize > MAX_HEADER_BYTES) {
    throw new AsarError(`implausible header size ${headerSize}`);
  }
  if (8 + headerSize > buffer.length) throw new AsarError("header size runs past the end of the archive");
  if (readU32(buffer, 8, "header payload size") !== headerSize - 4) throw new AsarError("header payload size disagrees with header size");
  const jsonLength = readU32(buffer, 12, "header JSON length");
  if (8 + jsonLength > headerSize || roundUp(jsonLength, ALIGN) !== headerSize - 8) {
    throw new AsarError(`header JSON length ${jsonLength} disagrees with header size ${headerSize}`);
  }
  const headerText = buffer.toString("utf8", 16, 16 + jsonLength);
  if (Buffer.byteLength(headerText, "utf8") !== jsonLength) throw new AsarError("header JSON length is not a whole number of characters");
  let header;
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new AsarError("header JSON is not parseable");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new AsarError("header JSON is not an object");
  if (header.files !== undefined && (typeof header.files !== "object" || header.files === null || Array.isArray(header.files))) {
    throw new AsarError("header `files` is not an object");
  }
  const bodyOffset = 8 + headerSize;
  const files = new Map();
  walkFiles(header.files ?? {}, "", files, 1);

  const packed = [];
  for (const [path, node] of files) {
    if (node.link !== undefined || node.unpacked === true) continue; // no bytes inside this archive
    if (!Number.isInteger(node.size) || node.size < 0) throw new AsarError(`${JSON.stringify(path)} has an invalid size`);
    if (node.offset === undefined || node.offset === null || node.offset === "") throw new AsarError(`${JSON.stringify(path)} has no body offset`);
    const offset = typeof node.offset === "number" ? node.offset : Number(node.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AsarError(`${JSON.stringify(path)} has an invalid offset ${JSON.stringify(node.offset)}`);
    packed.push({ path, node, offset, start: bodyOffset + offset, end: bodyOffset + offset + node.size });
  }
  packed.sort((a, b) => a.start - b.start || a.end - b.end);
  // Real archives dedupe identical content: several entries point at one exact byte range. That is allowed (the entries
  // must also agree on integrity); any other overlap, including a range that merely nests inside or straddles another, is not.
  let reach = null; // the distinct non-empty range with the furthest end seen so far
  for (const entry of packed) {
    if (entry.end > buffer.length) throw new AsarError(`${JSON.stringify(entry.path)} reads past the end of the archive`);
    if (entry.node.size === 0) continue; // an empty file owns no bytes, so it cannot collide with anything
    if (reach && entry.start < reach.end) {
      const exact = entry.start === reach.start && entry.end === reach.end;
      if (!exact) throw new AsarError(`${JSON.stringify(entry.path)} overlaps ${JSON.stringify(reach.path)}`);
      if (JSON.stringify(entry.node.integrity ?? null) !== JSON.stringify(reach.node.integrity ?? null)) {
        throw new AsarError(`${JSON.stringify(entry.path)} shares bytes with ${JSON.stringify(reach.path)} but not its integrity record`);
      }
      entry.shared = reach.shared = true;
    } else {
      reach = entry;
    }
  }
  const byPath = new Map(packed.map(entry => [entry.path, entry]));
  return { header, headerText, headerSha256: sha256Text(headerText), headerSize, bodyOffset, files, packed, byPath };
}

function resolveTarget(info, relativePath, action) {
  const path = normalizeAsarPath(relativePath);
  const node = info.files.get(path);
  if (!node) throw new AsarError(`cannot ${action} ${JSON.stringify(path)}: not a file in the archive`);
  const entry = info.byPath.get(path);
  if (!entry) {
    if (node.link !== undefined) throw new AsarError(`cannot ${action} ${JSON.stringify(path)}: it is a symlink entry`);
    throw new AsarError(`cannot ${action} ${JSON.stringify(path)}: it is unpacked, so its bytes live outside the archive`);
  }
  return { path, node, entry };
}

/** The bytes stored for one archive file, or an AsarError if the path is absent, escapes, or has no packed bytes. */
export function readAsarFile(buffer, relativePath) {
  const info = parseAsar(buffer);
  const { node, entry } = resolveTarget(info, relativePath, "read");
  return Buffer.from(buffer.subarray(entry.start, entry.start + node.size));
}

function setOffset(node, value) {
  node.offset = typeof node.offset === "string" ? String(value) : value;
}

function refreshedIntegrity(content, previous) {
  const algorithm = typeof previous.algorithm === "string" && previous.algorithm ? previous.algorithm : "SHA256";
  const blockSize = Number.isInteger(previous.blockSize) && previous.blockSize > 0 ? previous.blockSize : DEFAULT_BLOCK_SIZE;
  const blocks = [];
  for (let at = 0; at < content.length; at += blockSize) blocks.push(digestWith(algorithm, content.subarray(at, at + blockSize)));
  if (!blocks.length) blocks.push(digestWith(algorithm, content.subarray(0, 0)));
  return { algorithm, hash: digestWith(algorithm, content), blockSize, blocks };
}

/**
 * Replace one file's bytes and return a new archive plus the SHA-256 of the new header's raw JSON text. A target with
 * a deduplicated (shared) byte range is appended instead of spliced. Otherwise only the target's bytes are spliced: its size and the offsets of entries that start after it shift by the delta, and its
 * integrity block list is rebuilt in place when it had one. Everything else — other entries, their integrity, header
 * key order and the untouched body bytes — is preserved.
 */
export function replaceAsarFile(buffer, relativePath, replacement) {
  if (!Buffer.isBuffer(replacement)) throw new AsarError("replacement content must be a Buffer");
  const info = parseAsar(buffer);
  const { node, entry } = resolveTarget(info, relativePath, "replace");
  const bodyLength = buffer.length - info.bodyOffset;
  // A target whose byte range is shared with another entry cannot be edited in place without changing that entry, so its
  // new bytes go after the existing body and only the target's offset moves. Otherwise the bytes are spliced in place
  // and every entry that starts after the target shifts by the size change.
  // An empty target owns no bytes of its own, but its offset may sit inside another entry's range, so it is appended too.
  const append = entry.shared === true || node.size === 0;
  const delta = append ? replacement.length : replacement.length - node.size;
  if (append) {
    setOffset(node, bodyLength);
  } else {
    const targetEnd = entry.offset + node.size;
    for (const other of info.packed) {
      if (other === entry) continue;
      if (other.offset >= targetEnd) setOffset(other.node, other.offset + delta);
      // An empty entry parked strictly inside the target must not be left pointing past the target's new end.
      else if (other.node.size === 0 && other.offset > entry.offset) setOffset(other.node, Math.min(other.offset, entry.offset + replacement.length));
    }
  }
  node.size = replacement.length;
  if (node.integrity) node.integrity = refreshedIntegrity(replacement, node.integrity);

  const headerText = JSON.stringify(info.header);
  const jsonLength = Buffer.byteLength(headerText, "utf8");
  const headerSize = 8 + roundUp(jsonLength, ALIGN);
  if (headerSize > MAX_HEADER_BYTES) throw new AsarError(`new header of ${headerSize} bytes exceeds the ${MAX_HEADER_BYTES} byte limit`);
  const headerBlock = Buffer.alloc(headerSize); // zero-filled, which is how asar pads the header
  headerBlock.writeUInt32LE(headerSize - 4, 0);
  headerBlock.writeUInt32LE(jsonLength, 4);
  if (headerBlock.write(headerText, 8, jsonLength, "utf8") !== jsonLength) throw new AsarError("header JSON did not serialize to its byte length");

  const archive = Buffer.alloc(8 + headerSize + bodyLength + delta);
  archive.writeUInt32LE(MAGIC, 0);
  archive.writeUInt32LE(headerSize, 4);
  headerBlock.copy(archive, 8);
  const bodyOut = 8 + headerSize;
  if (append) {
    buffer.copy(archive, bodyOut, info.bodyOffset, buffer.length);
    replacement.copy(archive, bodyOut + bodyLength);
  } else {
    const before = entry.start - info.bodyOffset;
    buffer.copy(archive, bodyOut, info.bodyOffset, entry.start);
    replacement.copy(archive, bodyOut + before);
    buffer.copy(archive, bodyOut + before + replacement.length, entry.end, buffer.length);
  }
  return { archive, headerSha256: sha256Text(headerText) };
}
