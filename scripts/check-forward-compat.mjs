#!/usr/bin/env node
// Before publishing: would the release that is deployed now hand chats to this candidate without a restart?
// It runs the deployed release's own forwarding code (dist/installed-release-runtime.js) against the candidate's extracted
// package, in a private layout under /tmp that mirrors an install: releases/<deployed> running, current -> <candidate>.
// No service, account, chat or inference is touched. See docs/RELEASING.md and docs/services.md.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { deployed: { type: 'string' }, candidate: { type: 'string' }, json: { type: 'boolean' } } });
if (!values.deployed || !values.candidate) {
  console.error('Usage: check-forward-compat.mjs --deployed INSTALLED_PACKAGE_DIR --candidate RELEASE_ARCHIVE.tar.gz');
  process.exit(64);
}
const deployedPackage = resolve(values.deployed);
const version = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
const sdkSha = dir => { try { return JSON.parse(readFileSync(join(dir, 'gateway-sdk/build.json'), 'utf8')).binarySha256; } catch { return undefined; } };
const report = verdict => {
  console.log(values.json ? JSON.stringify(verdict) : `forward check ${verdict.ok ? 'passed' : 'FAILED'}: ${verdict.reason} (${verdict.deployed} -> ${verdict.candidate})`);
  process.exitCode = verdict.ok ? 0 : 1;
};

const root = mkdtempSync('/tmp/gw-forward-check-');
async function check() {
  const extract = join(root, 'extract'); mkdirSync(extract, { mode: 0o700 });
  execFileSync('/usr/bin/tar', ['-xzf', resolve(values.candidate), '-C', extract]);
  const [top] = readdirSync(extract); const candidatePackage = join(extract, top, 'package');
  const from = version(deployedPackage), to = version(candidatePackage);
  if (from === to) throw new Error(`deployed and candidate are both ${to}`);
  const deployedSdk = sdkSha(deployedPackage), candidateSdk = sdkSha(candidatePackage);
  const base = { deployed: from, candidate: to };
  // The same SDK needs no forwarding: a host serves an adapter of its own SDK itself.
  if (deployedSdk && deployedSdk === candidateSdk) return { ok: true, reason: 'same_gateway_sdk', ...base };
  if (!candidateSdk) return { ok: false, reason: 'candidate_without_gateway_sdk', ...base };

  const releases = join(root, 'releases'); mkdirSync(releases, { mode: 0o700 });
  const running = join(releases, from, 'package');
  mkdirSync(running, { recursive: true, mode: 0o700 });
  cpSync(join(deployedPackage, 'dist'), join(running, 'dist'), { recursive: true });
  cpSync(join(deployedPackage, 'package.json'), join(running, 'package.json'));
  if (existsSync(join(deployedPackage, 'node_modules'))) symlinkSync(join(deployedPackage, 'node_modules'), join(running, 'node_modules'));
  mkdirSync(join(releases, to), { mode: 0o700 });
  renameSync(candidatePackage, join(releases, to, 'package'));
  for (const name of [from, to]) writeFileSync(join(releases, name, '.gateway-release'), `${name}\n`, { mode: 0o600 });
  symlinkSync(`releases/${to}`, join(root, 'current'));

  const deployedModule = join(running, 'dist/installed-release-runtime.js');
  if (!existsSync(deployedModule)) return { ok: false, reason: 'deployed_release_cannot_forward', ...base };
  const { installedReleaseRuntime } = await import(pathToFileURL(deployedModule).href);
  const loaded = await installedReleaseRuntime(to, pathToFileURL(deployedModule).href);
  if (!loaded) return { ok: false, reason: 'deployed_release_refuses_candidate', ...base };
  loaded.lease?.release?.();
  if (loaded.runtime.binarySha256 !== candidateSdk) return { ok: false, reason: 'candidate_sdk_mismatch', ...base };
  // The host also requires the same Code Mode support (src/execution-host.ts forwardRuntime).
  const { gatewaySdkRuntime } = await import(pathToFileURL(join(running, 'dist/gateway-sdk-runtime.js')).href);
  const own = await gatewaySdkRuntime(deployedPackage);
  if (!own) return { ok: false, reason: 'deployed_sdk_unverified', ...base };
  if (own.codeModeHost !== loaded.runtime.codeModeHost) return { ok: false, reason: 'code_mode_differs', ...base };
  return { ok: true, reason: loaded.preparation ? 'forwards' : 'forwards_legacy', ...base };
}
try { report(await check()); } finally { rmSync(root, { recursive: true, force: true }); }
