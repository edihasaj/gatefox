import { existsSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CODES = 16;
const MAX_FILES = 16;
const MAX_LOCATIONS = 16;
const MAX_TYPES = 16;
const MAX_LINE = 8 * 1024;
const MAX_TOTAL = 1_000_000_000;
const allowedReasons = new Set(['nonzero_exit', 'timeout', 'output_limit', 'spawn_error', 'cancelled']);
const allowedSignals = new Set([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGEMT', 'SIGFPE', 'SIGKILL',
  'SIGBUS', 'SIGSEGV', 'SIGSYS', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGURG', 'SIGSTOP', 'SIGTSTP',
  'SIGCONT', 'SIGCHLD', 'SIGTTIN', 'SIGTTOU', 'SIGIO', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF',
  'SIGWINCH', 'SIGUSR1', 'SIGUSR2',
]);
const allowedFailureTypes = new Set([
  'testCodeFailure', 'subtestsFailed', 'hookFailed', 'uncaughtException', 'unhandledRejection',
  'testTimeoutFailure', 'cancelledByParent', 'ERR_ASSERTION', 'ERR_TEST_FAILURE',
  'ERR_TEST_FAILURE', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
]);
const totalKeys = new Set(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);
const relativeTestPath = /^(?:dist\/tests\/[A-Za-z0-9][A-Za-z0-9._/-]*\.test\.js|scripts\/tests\/provider-[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs)$/;

function boundedAdd(values, value, maximum) {
  if (values.length < maximum && !values.includes(value)) values.push(value);
}

function boundedLocation(values, value) {
  if (values.length < MAX_LOCATIONS && !values.some(existing => existing.file === value.file && existing.line === value.line && existing.column === value.column)) values.push(value);
}

function ownValue(object, key) {
  try { return object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined; }
  catch { return undefined; }
}

/** Accept only a real, candidate-relative test path. Never serialize arbitrary output paths. */
function normalizedCandidatePath(path, cwd) {
  if (!cwd) return undefined;
  try {
    const root = realpathSync(cwd);
    const file = realpathSync(resolve(root, path));
    const fromRoot = relative(root, file);
    if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || !existsSync(file) || !statSync(file).isFile()) return undefined;
    const candidatePath = fromRoot.split(sep).join('/');
    return relativeTestPath.test(candidatePath) ? candidatePath : undefined;
  } catch { return undefined; }
}

export function candidateTestPath(value, cwd) {
  if (typeof value !== 'string' || value.length > 512 || !relativeTestPath.test(value) || value.split('/').includes('..')) return undefined;
  return normalizedCandidatePath(value, cwd);
}

/** Preserve an absolute location long enough to prove it is inside the candidate. */
export function candidateOutputPath(value, cwd) {
  if (typeof value !== 'string' || value.length > 1024) return undefined;
  if (value.startsWith('file://')) {
    try { return normalizedCandidatePath(fileURLToPath(value), cwd); } catch { return undefined; }
  }
  if (value.startsWith('/')) return normalizedCandidatePath(value, cwd);
  return candidateTestPath(value, cwd);
}

/** Parse only fixed, content-free validation facts from bounded child output lines. */
export class ValidationDiagnostics {
  #cwd;
  #files = [];
  #locations = [];
  #types = [];
  #codes = [];
  #totals = {};
  #paths = new Map();

  constructor(cwd) { this.#cwd = cwd; }

  line(line) {
    if (typeof line !== 'string') return;
    line = line.slice(0, MAX_LINE);
    let seen = 0;
    for (const match of line.matchAll(/(?:error\[(E\d{4,5})\]|error\s+(TS\d{4,5}))/g)) { if (++seen > 64) break; boundedAdd(this.#codes, match[1] ?? match[2], MAX_CODES); }
    seen = 0;
    for (const match of line.matchAll(/(?:failureType|failure_type)\s*[:=]\s*['"]?([A-Za-z][A-Za-z0-9_]{0,63})/g)) {
      if (++seen > 64) break;
      if (allowedFailureTypes.has(match[1])) boundedAdd(this.#types, match[1], MAX_TYPES);
    }
    seen = 0;
    for (const match of line.matchAll(/\b(ERR_[A-Z0-9_]{3,64})\b/g)) {
      if (++seen > 64) break;
      if (allowedFailureTypes.has(match[1])) boundedAdd(this.#types, match[1], MAX_TYPES);
    }
    const total = /^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/i.exec(line);
    if (total && totalKeys.has(total[1].toLowerCase())) {
      const number = Number(total[2]);
      if (Number.isSafeInteger(number) && number <= MAX_TOTAL) this.#totals[total[1].toLowerCase()] = number;
    }
    seen = 0;
    for (const match of line.matchAll(/(?<![A-Za-z0-9._/-])((?:(?:file:\/\/)?(?:\/[A-Za-z0-9._~%-]+)+\/)?(?:dist\/tests\/[A-Za-z0-9][A-Za-z0-9._/-]*\.test\.js|scripts\/tests\/provider-[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs)):(\d+)(?::(\d+))?/g)) {
      if (++seen > 64) break;
      let file = this.#paths.get(match[1]);
      if (file === undefined && this.#paths.size < 64) { file = candidateOutputPath(match[1], this.#cwd) ?? null; this.#paths.set(match[1], file); }
      if (!file) continue;
      boundedAdd(this.#files, file, MAX_FILES);
      const lineNumber = Number(match[2]); const column = match[3] === undefined ? undefined : Number(match[3]);
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > MAX_TOTAL ||
        (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > MAX_TOTAL))) continue;
      boundedLocation(this.#locations, column === undefined ? { file, line: lineNumber } : { file, line: lineNumber, column });
    }
  }

  metadata() {
    const result = {};
    if (this.#files.length) result.failureFiles = this.#files;
    if (this.#locations.length) result.failureLocations = this.#locations;
    if (this.#types.length) result.failureTypes = this.#types;
    if (this.#codes.length) result.compilerCodes = this.#codes;
    if (Object.keys(this.#totals).length) result.testTotals = this.#totals;
    return result;
  }
}

function safeList(value, limit, mapper) {
  try { if (!Array.isArray(value)) return undefined; } catch { return undefined; }
  const result = [];
  const length = Math.min(Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : 0, limit * 4);
  for (let index = 0; index < length; index++) {
    try {
      const safe = mapper(value[index]);
      if (safe !== undefined) boundedAdd(result, safe, limit);
    } catch {}
  }
  return result.length ? result : undefined;
}

/** Re-check error metadata before latest.json receives it, including injected test doubles. */
export function safeValidationMetadata(error, cwd) {
  try { return safeValidationMetadataInner(error, cwd); } catch { return {}; }
}

function safeValidationMetadataInner(error, cwd) {
  const metadata = {};
  const failureReason = ownValue(error, 'failureReason');
  const exitCode = ownValue(error, 'exitCode');
  const signal = ownValue(error, 'signal');
  if (allowedReasons.has(failureReason)) metadata.failureReason = failureReason;
  if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) metadata.exitCode = exitCode;
  if (allowedSignals.has(signal)) metadata.signal = signal;
  const files = safeList(ownValue(error, 'failureFiles'), MAX_FILES, file => candidateTestPath(file, cwd));
  if (files) metadata.failureFiles = files;
  const rawLocations = safeList(ownValue(error, 'failureLocations'), MAX_LOCATIONS, location => {
    const file = candidateTestPath(ownValue(location, 'file'), cwd);
    const line = ownValue(location, 'line'); const column = ownValue(location, 'column');
    if (!file || !Number.isSafeInteger(line) || line < 1 || line > MAX_TOTAL ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > MAX_TOTAL))) return undefined;
    return column === undefined ? { file, line } : { file, line, column };
  });
  if (rawLocations) {
    const locations = [];
    for (const location of rawLocations) boundedLocation(locations, location);
    if (locations.length) metadata.failureLocations = locations;
  }
  const types = safeList(ownValue(error, 'failureTypes'), MAX_TYPES, type => allowedFailureTypes.has(type) ? type : undefined);
  if (types) metadata.failureTypes = types;
  const codes = safeList(ownValue(error, 'compilerCodes'), MAX_CODES, code => typeof code === 'string' && /^(?:E|TS)\d{4,5}$/.test(code) ? code : undefined);
  if (codes) metadata.compilerCodes = codes;
  const testTotals = ownValue(error, 'testTotals');
  if (testTotals && typeof testTotals === 'object' && !Array.isArray(testTotals)) {
    const totals = {};
    for (const key of totalKeys) {
      const value = ownValue(testTotals, key);
      if (totalKeys.has(key) && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOTAL) totals[key] = value;
    }
    if (Object.keys(totals).length) metadata.testTotals = totals;
  }
  return metadata;
}
