#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { withPrivateFileLock } from '../dist/private-file-lock.js';
import { assertCargoTargetLocksAvailable, withCargoTargetLocks } from './cargo-target-lock.mjs';

const targets = [
  { name: 'gateway SDK target', root: '.state/gateway-sdk-build', target: 'target', manifest: ['sdk-', 'codex-rs/Cargo.toml'] },
  { name: 'native relay target', root: '.state/native-relay-build', target: 'target', manifest: ['build-', 'Cargo.toml'] },
  { name: 'native relay SDK target', root: '.state/native-relay-build', target: 'sdk-target', manifest: ['sdk-', 'codex-rs/Cargo.toml'] },
];

function directoryBytes(path) {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(child);
    else if (entry.isFile()) bytes += lstatSync(child).size;
  }
  return bytes;
}

function findManifest(root, [prefix, suffix]) {
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith(prefix)) continue;
    const candidate = join(root, name, suffix);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function lockPid(path) {
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function pidIsLive(pid) {
  try { process.kill(pid, 0); return pid; }
  catch (error) { if (error.code === 'EPERM') return pid; return undefined; }
}

function assertBuildLockCanBeAcquired(root) {
  const lock = join(root, 'build.lock');
  if (!existsSync(lock)) return;
  const pid = lockPid(lock);
  if (pid && pidIsLive(pid)) throw new Error(`Refusing release cleanup while ${lock} is held by live pid ${pid}`);
  const age = Date.now() - lstatSync(lock).mtimeMs;
  if (!pid && Math.abs(age) < 60_000) {
    throw new Error(`Refusing release cleanup while ${lock} may be held while its pid is being recorded`);
  }
}

export function releaseCleanPlan({ cwd = process.cwd() } = {}) {
  const entries = targets.map(specification => {
    const root = resolve(cwd, specification.root);
    const target = join(root, specification.target);
    const present = existsSync(target) && lstatSync(target).isDirectory();
    return {
      ...specification, root, target, present,
      bytes: present ? directoryBytes(target) : 0,
      manifest: present ? findManifest(root, specification.manifest) : undefined,
    };
  });
  const state = resolve(cwd, '.state');
  const fixtures = existsSync(state) ? readdirSync(state).sort()
    .filter(name => /^app-update-e2e-/.test(name))
    .map(name => join(state, name)).filter(path => lstatSync(path).isDirectory())
    .map(path => ({ path, bytes: directoryBytes(path) })) : [];
  return { entries, fixtures };
}

function printPlan(plan, { dryRun, cwd }) {
  let reclaimed = 0;
  for (const entry of plan.entries) {
    const display = relative(cwd, entry.target) || entry.target;
    if (!entry.present) {
      console.log(`skip ${display}: target directory does not exist`);
    } else if (!entry.manifest) {
      console.log(`skip ${display}: no Cargo.toml found in ${relative(cwd, entry.root) || entry.root}`);
    } else if (dryRun) {
      console.log(`would run cargo clean --manifest-path ${relative(cwd, entry.manifest)} --target-dir ${display} (${entry.bytes} bytes)`);
      reclaimed += entry.bytes;
    } else {
      const before = directoryBytes(entry.target);
      execFileSync('cargo', ['clean', '--manifest-path', entry.manifest, '--target-dir', entry.target], { stdio: 'inherit' });
      const after = existsSync(entry.target) ? directoryBytes(entry.target) : 0;
      reclaimed += Math.max(0, before - after);
      console.log(`cleaned ${display}: ${Math.max(0, before - after)} bytes reclaimed`);
    }
  }
  for (const fixture of plan.fixtures) {
    const display = relative(cwd, fixture.path) || fixture.path;
    console.log(`retained fixture ${display}: ${fixture.bytes} bytes; remove manually with: trash "${fixture.path}"`);
  }
  console.log(`${dryRun ? 'would reclaim' : 'reclaimed'} ${reclaimed} bytes`);
  return reclaimed;
}

async function withBuildLocks(roots, operation) {
  const locks = [...new Set(roots.filter(existsSync))].sort();
  const acquire = async index => {
    if (index === locks.length) return operation();
    const root = locks[index];
    assertBuildLockCanBeAcquired(root);
    return withPrivateFileLock(join(root, 'build'), () => acquire(index + 1), 60_000);
  };
  return acquire(0);
}

export async function runReleaseClean({ cwd = process.cwd(), dryRun = false } = {}) {
  const absolute = resolve(cwd);
  const roots = targets.map(entry => resolve(absolute, entry.root));
  const cargoTargets = targets.map(entry => resolve(absolute, entry.root, entry.target))
    .filter(target => existsSync(dirname(target)));
  return withBuildLocks(roots, async () => {
    assertCargoTargetLocksAvailable(cargoTargets);
    return withCargoTargetLocks(cargoTargets, () =>
      printPlan(releaseCleanPlan({ cwd: absolute }), { dryRun, cwd: absolute }));
  });
}

function parseArgs(argv) {
  if (argv.length === 0) return { dryRun: false };
  if (argv.length === 1 && argv[0] === '--dry-run') return { dryRun: true };
  throw new Error('Usage: node scripts/release-clean.mjs [--dry-run]');
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await runReleaseClean(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
