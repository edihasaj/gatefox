import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const NAMESPACE_ENTRIES = new Set(['build.lock', 'staging', 'latest']);
const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;

function safeDirectory(path, message) {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (UID !== undefined && entry.uid !== UID)) throw new Error(message);
}

function safeFile(path, message) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (UID !== undefined && entry.uid !== UID)) throw new Error(message);
  return entry;
}

function ensureDirectory(path, message) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  safeDirectory(path, message);
}

function pidIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function sameFile(path, expected) {
  if (!existsSync(path)) return false;
  const current = lstatSync(path);
  return current.isFile() && !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino;
}

function removeOwnedDirectory(path, prefix) {
  if (!existsSync(path)) return;
  safeDirectory(path, `Refusing unsafe release staging directory: ${path}`);
  if (!path.split('/').at(-1)?.startsWith(prefix)) throw new Error(`Refusing unexpected release staging directory: ${path}`);
  assertOwnedTree(path);
  rmSync(path, { recursive: true, force: false, maxRetries: 2 });
}

function namespaceFor(cwd) {
  const digest = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(tmpdir(), 'harness-gateway-release', digest);
}

function releaseLockOwner(path) {
  const entry = safeFile(path, `Refusing unsafe release lock: ${path}`);
  let owner;
  try { owner = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Refusing malformed release lock: ${path}`); }
  if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error(`Refusing malformed release lock: ${path}`);
  return { entry, owner };
}

function assertOwnedTree(path) {
  const entry = lstatSync(path);
  if (UID !== undefined && entry.uid !== UID) throw new Error(`Refusing unsafe release staging content: ${path}`);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) for (const name of readdirSync(path)) assertOwnedTree(join(path, name));
}

function assertNamespace(root) {
  ensureDirectory(join(tmpdir(), 'harness-gateway-release'), `Refusing unsafe release namespace parent: ${join(tmpdir(), 'harness-gateway-release')}`);
  ensureDirectory(root, `Refusing unsafe release namespace: ${root}`);
  for (const name of readdirSync(root)) {
    if (!NAMESPACE_ENTRIES.has(name)) throw new Error(`Refusing unexpected file in release namespace: ${join(root, name)}`);
    const path = join(root, name);
    if (name === 'build.lock') safeFile(path, `Refusing unsafe release lock: ${path}`);
    else safeDirectory(path, `Refusing unsafe release namespace entry: ${path}`);
  }
}

function assertLatest(root) {
  if (!existsSync(root)) return;
  safeDirectory(root, `Refusing unsafe latest release output: ${root}`);
  const names = readdirSync(root);
  const archives = names.filter(name => /^harness-gateway-[\w.-]+-macos-arm64\.tar\.gz$/.test(name));
  if (archives.length !== 1 || names.length !== 2 || !names.includes('SHA256SUMS')) {
    throw new Error(`Refusing unexpected latest release output: ${root}`);
  }
  for (const name of names) safeFile(join(root, name), `Refusing unsafe latest release output: ${join(root, name)}`);
}

function writeLock(path) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 }); }
  finally { closeSync(fd); }
}

function createLock(path) {
  try {
    writeLock(path);
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const { owner } = releaseLockOwner(path);
  if (pidIsLive(owner.pid)) throw new Error(`Refusing release build while active build lock is held by pid ${owner.pid}`);
  throw new Error(`Refusing stale release build lock at ${path}; after confirming pid ${owner.pid} stopped, remove that exact lock manually`);
}

function prepareExplicitOutput(path) {
  ensureDirectory(path, `Refusing unsafe --output-dir: ${path}`);
  for (const name of readdirSync(path)) {
    if (name === 'SHA256SUMS' || /^harness-gateway-[\w.-]+-macos-arm64\.tar\.gz$/.test(name)) {
      safeFile(join(path, name), `Refusing unsafe --output-dir entry: ${join(path, name)}`);
    }
  }
}

export class ReleaseTempStorage {
  constructor({ cwd = process.cwd(), outputDir } = {}) {
    this.cwd = resolve(cwd);
    this.explicitOutput = outputDir !== undefined;
    this.namespace = namespaceFor(this.cwd);
    this.lock = join(this.namespace, 'build.lock');
    this.outputDirectory = outputDir === undefined ? join(this.namespace, 'latest') : resolve(this.cwd, outputDir);
  }

  acquire() {
    assertNamespace(this.namespace);
    createLock(this.lock);
    try {
      this.lockEntry = safeFile(this.lock, `Refusing unsafe release lock: ${this.lock}`);
      const staging = join(this.namespace, 'staging');
      if (!existsSync(staging)) mkdirSync(staging, { mode: 0o700 });
      safeDirectory(staging, `Refusing unsafe release staging root: ${staging}`);
      for (const name of readdirSync(staging)) removeOwnedDirectory(join(staging, name), 'build-');
      if (this.explicitOutput) prepareExplicitOutput(this.outputDirectory);
      else assertLatest(this.outputDirectory);
      this.stage = join(staging, `build-${process.pid}-${randomBytes(10).toString('hex')}`);
      mkdirSync(this.stage, { mode: 0o700 });
      this.work = join(this.stage, 'work');
      this.output = join(this.stage, 'output');
      mkdirSync(this.work, { mode: 0o700 });
      mkdirSync(this.output, { mode: 0o700 });
      return this;
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  complete({ assetName }) {
    if (!/^[\w.-]+\.tar\.gz$/.test(assetName)) throw new Error(`Unsafe release asset name: ${assetName}`);
    const stagedAsset = join(this.output, assetName);
    const stagedChecksum = join(this.output, 'SHA256SUMS');
    safeFile(stagedAsset, `Missing release asset: ${stagedAsset}`);
    safeFile(stagedChecksum, `Missing release checksum: ${stagedChecksum}`);
    if (readdirSync(this.output).length !== 2) throw new Error(`Unexpected release output files in ${this.output}`);
    let result;
    if (this.explicitOutput) {
      const asset = join(this.outputDirectory, assetName);
      const checksum = join(this.outputDirectory, 'SHA256SUMS');
      const nonce = `${process.pid}-${randomBytes(8).toString('hex')}`;
      const temporaryAsset = join(this.outputDirectory, `.${assetName}.${nonce}`);
      const temporaryChecksum = join(this.outputDirectory, `.SHA256SUMS.${nonce}`);
      const restoreAsset = join(this.outputDirectory, `.${assetName}.restore-${nonce}`);
      const previousAsset = join(this.stage, 'previous-asset');
      const hadAsset = existsSync(asset);
      if (hadAsset) copyFileSync(asset, previousAsset);
      let assetPublished = false;
      try {
        copyFileSync(stagedAsset, temporaryAsset);
        copyFileSync(stagedChecksum, temporaryChecksum);
        renameSync(temporaryAsset, asset);
        assetPublished = true;
        renameSync(temporaryChecksum, checksum);
      } catch (error) {
        if (assetPublished) {
          if (hadAsset) {
            copyFileSync(previousAsset, restoreAsset);
            renameSync(restoreAsset, asset);
          }
          else rmSync(asset, { force: true });
        }
        throw error;
      } finally {
        if (existsSync(temporaryAsset)) rmSync(temporaryAsset, { force: true });
        if (existsSync(temporaryChecksum)) rmSync(temporaryChecksum, { force: true });
        if (existsSync(restoreAsset)) rmSync(restoreAsset, { force: true });
      }
      result = { asset, checksum };
    } else {
      const previous = join(this.stage, 'previous-latest');
      if (existsSync(this.outputDirectory)) renameSync(this.outputDirectory, previous);
      try { renameSync(this.output, this.outputDirectory); }
      catch (error) {
        if (existsSync(previous) && !existsSync(this.outputDirectory)) renameSync(previous, this.outputDirectory);
        throw error;
      }
      if (existsSync(previous)) rmSync(previous, { recursive: true, force: false, maxRetries: 2 });
      result = { asset: join(this.outputDirectory, assetName), checksum: join(this.outputDirectory, 'SHA256SUMS') };
    }
    this.cleanup();
    return result;
  }

  abort() { this.cleanup(); }

  cleanup() {
    if (this.stage && existsSync(this.stage)) removeOwnedDirectory(this.stage, 'build-');
    if (this.lockEntry && sameFile(this.lock, this.lockEntry)) rmSync(this.lock, { force: false });
    this.stage = undefined;
    this.lockEntry = undefined;
  }
}

export function withReleaseTempStorage(options, build) {
  const storage = new ReleaseTempStorage(options).acquire();
  const abort = signal => {
    storage.abort();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onInterrupt = () => abort('SIGINT');
  const onTerminate = () => abort('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    return { ...storage.complete(build(storage)), storage };
  } catch (error) {
    storage.abort();
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
