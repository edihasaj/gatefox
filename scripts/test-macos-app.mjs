import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const developer = '/Applications/Xcode.app/Contents/Developer';
const env = { ...process.env };
// Command Line Tools can compile the app but do not ship the XCTest framework.
if (!env.DEVELOPER_DIR && existsSync(developer)) env.DEVELOPER_DIR = developer;
execFileSync('swift', ['test', '--package-path', 'native/macos'], { env, stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'scripts/tests/macos-app-backend.test.mjs',
  'scripts/tests/macos-service-launcher.test.mjs', 'scripts/tests/sign-macos-app.test.mjs'], {
  env, stdio: 'inherit',
});
