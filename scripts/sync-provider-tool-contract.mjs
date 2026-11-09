import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

// Separate integration generations keep older gateway releases on their own verified tools.
const files = ['src/provider-tool-runtime.ts', 'src/cli.ts', 'src/cli-main.ts', 'src/token-command.ts', 'src/app-management/providers.ts', 'src/protocol/types.ts', 'src/providers/tool-catalog.ts', 'src/providers/cli-continuity.ts',
  ...readdirSync('src/providers').filter(name => /^(claude|copilot).*\.ts$/.test(name)).map(name => `src/providers/${name}`)].sort();
const hash = createHash('sha256');
for (const path of files) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
const text = '// Generated from CLI adapter sources by scripts/sync-provider-tool-contract.mjs.\n' +
  `export const providerToolContract = "gateway-provider-clis-v1-${hash.digest('hex')}";\n`;
const path = 'src/provider-tool-contract.ts';
if (process.argv.includes('--check')) {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) throw Error('Provider CLI integration contract is stale; run npm run build');
} else if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
