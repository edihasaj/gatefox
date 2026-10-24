// Certificate option of signNativeTrial: identity and keychain validation and arguments. No real signing; the command runner is injected.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEVELOPER_ID_SIGNING_IDENTITY, ENTITLEMENTS_FILE, OFFICIAL_APP, SIGNING_KEYCHAIN, SignError, TRIAL_SIGNING_IDENTITY, sanitizedTrialEntitlements, signNativeTrial } from "../claude-native-trial/sign.mjs";
import { FINGERPRINT, HAS_PLUTIL, ORIGINAL, fakeExec, fakeHome, noCalls, taskRoot, } from "./helpers/native-sign.mjs";

test("the default stays ad hoc: no keychain flag, ad-hoc label, no fingerprint", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec });
    const signs = calls.filter(call => call.args[0] === "--force");
    for (const sign of signs) {
      assert.equal(sign.args.includes("--keychain"), false);
      assert.equal(sign.args[sign.args.indexOf("--sign") + 1], "-");
    }
    assert.equal(receipt.signingIdentity, TRIAL_SIGNING_IDENTITY);
    assert.equal(receipt.signingFingerprint, null);
    assert.equal(receipt.signingKeychain, null);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("a configured certificate signs nested and main code with the fingerprint and the fixed keychain", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  const { home, keychain } = fakeHome();
  try {
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec, identity: FINGERPRINT.toLowerCase(), keychain, homeDirectory: home });
    const signs = calls.filter(call => call.args[0] === "--force");
    assert.equal(signs.length, 2);
    assert.deepEqual(signs[0].args, ["--force", "--deep", "--sign", FINGERPRINT, "--keychain", keychain, "--preserve-metadata=identifier,entitlements,flags,runtime", app]);
    assert.deepEqual(signs[1].args, ["--force", "--sign", FINGERPRINT, "--keychain", keychain, "--preserve-metadata=identifier,flags,runtime", "--entitlements", join(task, ENTITLEMENTS_FILE), app]);
    assert.equal(signs[1].args.includes("--deep"), false);
    assert.equal(calls.some(call => call.args.includes("--options") || call.args.some(arg => /library-validation|runtime/.test(arg) && !arg.startsWith("--preserve-metadata"))), false, "library validation is not disabled or altered");
    assert.deepEqual(receipt.removedEntitlementKeys, ["com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups"]);
    assert.deepEqual(receipt.preservedEntitlementKeys, Object.keys(sanitizedTrialEntitlements(ORIGINAL)).sort());
    assert.equal(receipt.signingIdentity, DEVELOPER_ID_SIGNING_IDENTITY);
    assert.equal(receipt.signingFingerprint, FINGERPRINT);
    assert.equal(receipt.signingKeychain, keychain);
    assert.equal(receipt.officialAppModified, false);
    const verifies = calls.filter(call => call.args[0] === "--verify").map(call => call.args.at(-1));
    assert.deepEqual(verifies, [OFFICIAL_APP, app, OFFICIAL_APP]);
  } finally {
    rmSync(task, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a certificate without a keychain argument signs by fingerprint and passes no --keychain", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec, identity: FINGERPRINT });
    for (const sign of calls.filter(call => call.args[0] === "--force")) {
      assert.equal(sign.args.includes("--keychain"), false);
      assert.equal(sign.args[sign.args.indexOf("--sign") + 1], FINGERPRINT);
    }
    assert.equal(receipt.signingIdentity, DEVELOPER_ID_SIGNING_IDENTITY);
    assert.equal(receipt.signingKeychain, null);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("identities other than '-' or an exact 40-digit hex fingerprint are refused before anything runs", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const bad = [
      "", " ", "--", "ad-hoc", "Developer ID Application: Applifyer", "D8A977A01A3CEE4199F5775C6101769099D48E6",
      `${FINGERPRINT}0`, `${FINGERPRINT.slice(0, 39)}G`, ` ${FINGERPRINT}`, `${FINGERPRINT} `, `${FINGERPRINT}\n`,
      `0x${FINGERPRINT.slice(2)}`, FINGERPRINT.replace(/.{2}/g, "$&:").slice(0, -1), "--keychain", null, 7, {}, [FINGERPRINT],
    ];
    for (const identity of bad) {
      const { calls, exec } = noCalls();
      await assert.rejects(signNativeTrial(app, { exec, identity }), err => err instanceof SignError && /identity/.test(err.message), JSON.stringify(identity));
      assert.equal(calls.length, 0, `nothing ran for ${JSON.stringify(identity)}`);
    }
    assert.equal(existsSync(join(task, ENTITLEMENTS_FILE)), false, "no artifact was written");
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("only the fixed canonical private apple-codesign keychain is accepted, and only with a certificate", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  const good = fakeHome();
  const open = fakeHome({ mode: 0o644 });
  const missing = mkdtempSync("/private/tmp/claude-sign-home.");
  const asDir = mkdtempSync("/private/tmp/claude-sign-home.");
  const linked = fakeHome();
  const homes = [good.home, open.home, missing, asDir, linked.home];
  try {
    const refuse = async (options, pattern) => {
      const { calls, exec } = noCalls();
      await assert.rejects(signNativeTrial(app, { exec, identity: FINGERPRINT, ...options }), err => err instanceof SignError && pattern.test(err.message), JSON.stringify(options));
      assert.equal(calls.length, 0, "nothing ran");
    };
    await refuse({ keychain: join(good.home, "Library/Keychains/login.keychain-db"), homeDirectory: good.home }, /fixed apple-codesign keychain/);
    await refuse({ keychain: "Library/Keychains/apple-codesign.keychain-db", homeDirectory: good.home }, /fixed apple-codesign keychain/);
    await refuse({ keychain: `${good.home}/Library/Keychains/../Keychains/apple-codesign.keychain-db`, homeDirectory: good.home }, /fixed apple-codesign keychain/);
    await refuse({ keychain: join(open.home, SIGNING_KEYCHAIN), homeDirectory: good.home }, /fixed apple-codesign keychain/);
    await refuse({ keychain: 7, homeDirectory: good.home }, /fixed apple-codesign keychain/);
    await refuse({ keychain: good.keychain, homeDirectory: "relative/home" }, /home directory must be absolute/);
    await refuse({ keychain: join(open.home, SIGNING_KEYCHAIN), homeDirectory: open.home }, /private/);
    await refuse({ keychain: join(missing, SIGNING_KEYCHAIN), homeDirectory: missing }, /does not exist/);
    mkdirSync(join(asDir, SIGNING_KEYCHAIN), { recursive: true });
    await refuse({ keychain: join(asDir, SIGNING_KEYCHAIN), homeDirectory: asDir }, /regular file/);
    const target = join(linked.home, "real.keychain-db");
    writeFileSync(target, "x", { mode: 0o600 });
    unlinkSync(linked.keychain);
    symlinkSync(target, linked.keychain);
    await refuse({ keychain: linked.keychain, homeDirectory: linked.home }, /canonical|regular file/);

    const { calls, exec } = noCalls();
    await assert.rejects(signNativeTrial(app, { exec, keychain: good.keychain, homeDirectory: good.home }), err => err instanceof SignError && /ad-hoc signature does not use a keychain/.test(err.message));
    await assert.rejects(signNativeTrial(app, { exec, identity: "-", keychain: good.keychain, homeDirectory: good.home }), /ad-hoc signature does not use a keychain/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(task, ENTITLEMENTS_FILE)), false, "no artifact was written");
  } finally {
    rmSync(task, { recursive: true, force: true });
    for (const dir of homes) rmSync(dir, { recursive: true, force: true });
  }
});
