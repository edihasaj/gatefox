import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The install root under a prefix, by the same rule as `installRootIn` in src/paths.ts: an existing share/gatefox,
 * else an existing share/subscription-gateway from before 1.8.0, else share/gatefox for a fresh installation.
 * Scripts import this copy because they can run before `dist` is built.
 */
export function installRoot(prefix) {
  const gatefox = join(prefix, 'share', 'gatefox'), legacy = join(prefix, 'share', 'subscription-gateway');
  return existsSync(gatefox) || !existsSync(legacy) ? gatefox : legacy;
}
