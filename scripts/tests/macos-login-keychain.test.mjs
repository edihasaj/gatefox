import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'gatefox-keychain-native-'));
const executable = join(scratch, 'keychain-policy');
test.before(() => {
  const source = join(scratch, 'policy.c');
  writeFileSync(source, `
#include <Security/Security.h>
#include <Security/AuthSession.h>
#include <pwd.h>
#include <sys/sysctl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdbool.h>
static int mode, calls, unlocked;
static OSStatus fake_open(const char *path, SecKeychainRef *out) { (void)path; *out = (SecKeychainRef)1; return mode == 4 ? errSecNotAvailable : 0; }
static OSStatus fake_status(SecKeychainRef keychain, SecKeychainStatus *out) { (void)keychain; *out = unlocked ? kSecUnlockStateStatus : 0; return 0; }
static OSStatus fake_session(SecuritySessionId input, SecuritySessionId *out, SessionAttributeBits *attributes) {
  (void)input; *out = 501; *attributes = mode == 3 ? 0 : sessionHasGraphicAccess; return 0;
}
static OSStatus fake_unlock(SecKeychainRef keychain, UInt32 length, const void *password, Boolean supplied) {
  (void)keychain; calls++; if (length || password || supplied) return errSecParam;
  if (mode == 2) return errSecUserCanceled;
  if (mode == 5) return errSecAuthFailed;
  unlocked = 1; return 0;
}
static int fake_boot(const char *name, void *out, size_t *length, void *input, size_t input_length) {
  (void)name; (void)input; (void)input_length;
  const char *value = "12345678-1234-1234-1234-123456789abc";
  memcpy(out, value, strlen(value) + 1); *length = strlen(value) + 1; return 0;
}
static void fake_release(CFTypeRef value) { (void)value; }
#define SecKeychainOpen fake_open
#define SecKeychainGetStatus fake_status
#define SessionGetInfo fake_session
#define SecKeychainUnlock fake_unlock
#define sysctlbyname fake_boot
#define CFRelease fake_release
#include "${resolve('native/macos/Sources/GatewayService/login-keychain.h')}"
int main(int argc, char **argv) {
  if (argc != 3) return 64;
  mode = argv[1][0] - '0'; unlocked = mode == 1;
  int result = login_keychain(argv[2][0] == '1');
  fprintf(stderr, "%d", calls); return result;
}
`);
  const compiled = spawnSync('/usr/bin/xcrun', ['clang', '-std=c17', '-Wall', '-Wextra', '-Werror', source,
    '-framework', 'Security', '-framework', 'CoreFoundation', '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
});
test.after(() => rmSync(scratch, { recursive: true, force: true }));

for (const [name, mode, unlock, state, calls] of [
  ['status does not unlock', 0, false, 'locked', 0],
  ['an unlocked keychain never prompts', 1, true, 'unlocked', 0],
  ['native unlock uses no password and verifies success', 0, true, 'unlocked', 1],
  ['cancellation is preserved', 2, true, 'cancelled', 1],
  ['headless sessions never prompt', 3, true, 'locked', 0],
  ['an unavailable keychain stays unknown', 4, true, 'unknown', 0],
  ['failed unlock stays failed', 5, true, 'failed', 1],
]) test(name, () => {
  const result = spawnSync(executable, [String(mode), unlock ? '1' : '0'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, String(calls));
  const value = JSON.parse(result.stdout);
  assert.equal(value.state, state); assert.equal(value.graphic, mode !== 3);
  assert.equal(value.session, 501); assert.equal(value.boot, '12345678-1234-1234-1234-123456789abc');
});
