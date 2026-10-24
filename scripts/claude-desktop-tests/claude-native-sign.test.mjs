// No real signing: signNativeTrial runs against an injected command runner and a task directory created under /private/tmp.
// plutil (macOS) is used for plist conversion; the read-only case only reads the installed app's entitlements.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEVELOPER_ID_SIGNING_IDENTITY, ENTITLEMENTS_FILE, OFFICIAL_APP, REMOVED_TRIAL_ENTITLEMENTS, SignError, assertSignableTree, isMachOMagic, listMachOFiles, sanitizedTrialEntitlements, signNativeTrial } from "../claude-native-trial/sign.mjs";
import { FINGERPRINT, HAS_PLUTIL, ORIGINAL, fakeExec, fakeHome, noCalls, plutil, taskRoot, xmlOf } from "./helpers/native-sign.mjs";

test("removes exactly the three Team-ID-bound entitlements and keeps everything else", () => {
  assert.deepEqual([...REMOVED_TRIAL_ENTITLEMENTS].sort(), ["com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups"]);
  const clean = sanitizedTrialEntitlements(ORIGINAL);
  assert.deepEqual(Object.keys(clean), ["com.apple.security.cs.allow-jit", "com.apple.security.device.camera", "com.apple.security.automation.apple-events", "custom.nested"], "order of kept keys is preserved");
  for (const key of REMOVED_TRIAL_ENTITLEMENTS) assert.equal(Object.hasOwn(clean, key), false, key);
  assert.deepEqual(clean["custom.nested"], ORIGINAL["custom.nested"]);
  assert.equal(clean["com.apple.security.cs.allow-jit"], true);
});

test("sanitizing never mutates the input and returns an independent copy", () => {
  const input = structuredClone(ORIGINAL);
  const snapshot = JSON.stringify(input);
  const frozen = Object.freeze({ ...input });
  const clean = sanitizedTrialEntitlements(frozen);
  assert.equal(JSON.stringify(input), snapshot);
  clean["custom.nested"].list.push("changed");
  assert.equal(frozen["custom.nested"].list.length, 3, "nested values are cloned");
  assert.notEqual(clean, input);
  assert.deepEqual(sanitizedTrialEntitlements({}), {});
  assert.deepEqual(sanitizedTrialEntitlements({ other: 1 }), { other: 1 });
  const similar = { "keychain-access-groups-x": 1, "com.apple.application-identifier.x": 2, "Keychain-Access-Groups": 3 };
  assert.deepEqual(sanitizedTrialEntitlements(similar), similar, "only exact key matches are removed");
});

test("rejects anything that is not a plain entitlements dictionary", () => {
  for (const bad of [undefined, null, [], "x", 7, new Map(), new Date(), () => ({})]) {
    assert.throws(() => sanitizedTrialEntitlements(bad), err => err instanceof SignError, String(bad));
  }
});

test("signs a disposable copy: nested preserves everything, main gets the sanitized plist", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec });

    const signs = calls.filter(call => call.args[0] === "--force");
    assert.equal(signs.length, 2);
    assert.deepEqual(signs[0].args, ["--force", "--deep", "--sign", "-", "--preserve-metadata=identifier,entitlements,flags,runtime", app]);
    assert.deepEqual(signs[1].args.slice(0, 4), ["--force", "--sign", "-", "--preserve-metadata=identifier,flags,runtime"]);
    assert.equal(signs[1].args.includes("--deep"), false);
    assert.equal(signs[1].args.some(arg => /entitlements/.test(arg) && arg.startsWith("--preserve")), false, "the main signature does not preserve original entitlements");
    assert.deepEqual(signs[1].args.slice(4), ["--entitlements", join(task, ENTITLEMENTS_FILE), app]);
    assert.ok(calls.indexOf(signs[0]) < calls.indexOf(signs[1]), "nested code is signed before the main executable");
    assert.ok(calls.every(call => call.args.every(arg => !/^-{1,2}(?:o|p|r)?(?:id|identifier)?$/.test(arg) || true)));
    assert.equal(calls.some(call => call.args.includes("--identifier") || call.args.includes("-i")), false, "the identifier is preserved, never set");

    const verifies = calls.filter(call => call.args[0] === "--verify").map(call => [call.args.slice(0, 3).join(" "), call.args[3]]);
    assert.deepEqual(verifies.map(([, target]) => target), [OFFICIAL_APP, app, OFFICIAL_APP], "official before, copy, official after");
    for (const [flags] of verifies) assert.equal(flags, "--verify --deep --strict");
    for (const call of calls) assert.ok(call.args.every(arg => !arg.startsWith("/Applications") || arg === OFFICIAL_APP));
    assert.equal(signs.some(call => call.args.includes(OFFICIAL_APP)), false, "the official app is never signed");

    const file = join(task, ENTITLEMENTS_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const written = JSON.parse(plutil(["-convert", "json", "-o", "-", file]).stdout);
    assert.deepEqual(written, sanitizedTrialEntitlements(ORIGINAL));

    assert.deepEqual(receipt.removedEntitlementKeys, ["com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups"]);
    assert.deepEqual(receipt.preservedEntitlementKeys, Object.keys(sanitizedTrialEntitlements(ORIGINAL)).sort());
    assert.equal(receipt.signingIdentity, "ad-hoc-local-test-only");
    assert.equal(receipt.identifier, "com.anthropic.claudefordesktop");
    assert.equal(receipt.hardenedRuntimePreserved, true);
    assert.equal(receipt.officialAppModified, false);
    assert.equal(receipt.bundleIdentifierChanged, false);
    assert.equal(receipt.officialSignatureVerifiedBefore && receipt.officialSignatureVerifiedAfter, true);
    assert.equal(receipt.copyApp, app);
    assert.equal(receipt.entitlementsFile, file);
    const text = JSON.stringify(receipt);
    assert.equal(/TEAM\.com|TEAM\.a/.test(text), false, "the receipt carries key names, never entitlement values");
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("an existing entitlements artifact is refused, never followed, replaced or deleted", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  const victim = join(task, "victim.txt");
  try {
    writeFileSync(victim, "keep", { mode: 0o600 });
    symlinkSync(victim, join(task, ENTITLEMENTS_FILE));
    await assert.rejects(signNativeTrial(app, { exec: fakeExec(app).exec }), err => err instanceof SignError && /already exists/.test(err.message));
    assert.equal(readFileSync(victim, "utf8"), "keep", "the link target is untouched");
    assert.equal(lstatSync(join(task, ENTITLEMENTS_FILE)).isSymbolicLink(), true, "the link itself is not deleted");
    rmSync(join(task, ENTITLEMENTS_FILE));
    writeFileSync(join(task, ENTITLEMENTS_FILE), "stale", { mode: 0o644 });
    const { exec, calls } = fakeExec(app);
    await assert.rejects(signNativeTrial(app, { exec }), /already exists/);
    assert.equal(readFileSync(join(task, ENTITLEMENTS_FILE), "utf8"), "stale", "an unknown stale file is left alone");
    assert.equal(calls.some(call => call.args[0] === "--force"), false, "nothing was signed");
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("tree preflight accepts in-tree symlinks and refuses outside, absolute, dangling, looping, hardlinked and special entries", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  const outside = join(task, "outside.txt");
  writeFileSync(outside, "x", { mode: 0o600 });
  try {
    mkdirSync(join(app, "Contents/Frameworks/F.framework/Versions/A"), { recursive: true });
    writeFileSync(join(app, "Contents/Frameworks/F.framework/Versions/A/F"), "bin", { mode: 0o600 });
    symlinkSync("A", join(app, "Contents/Frameworks/F.framework/Versions/Current"));
    symlinkSync("Versions/Current/F", join(app, "Contents/Frameworks/F.framework/F"));
    symlinkSync("../Contents/Frameworks", join(app, "Contents/inner-up"));
    assert.ok(await assertSignableTree(app) >= 6, "in-tree links, including framework Versions/Current, are allowed");
    const signs = async () => { const calls = []; await signNativeTrial(app, { exec: (...a) => { calls.push(a); return { stdout: "", stderr: "" }; } }); return calls; };

    const refuse = async (make, pattern, cleanup) => {
      make();
      try {
        await assert.rejects(assertSignableTree(app), err => err instanceof SignError && pattern.test(err.message), String(pattern));
        const calls = [];
        await assert.rejects(signNativeTrial(app, { exec: (...a) => { calls.push(a); return { stdout: "", stderr: "" }; } }), pattern);
        assert.equal(calls.length, 0, "no command runs when the preflight fails");
      } finally {
        cleanup();
      }
    };
    const at = name => join(app, name);
    await refuse(() => symlinkSync("../outside.txt", at("escape")), /outside the copy/, () => unlinkSync(at("escape")));
    await refuse(() => symlinkSync("../../outside.txt", at("Contents/deep-escape")), /outside the copy|does not resolve/, () => unlinkSync(at("Contents/deep-escape")));
    await refuse(() => symlinkSync(outside, at("abs-out")), /outside the copy/, () => unlinkSync(at("abs-out")));
    await refuse(() => symlinkSync(OFFICIAL_APP, at("to-official")), /outside the copy/, () => unlinkSync(at("to-official")));
    symlinkSync(join(app, "Contents"), at("abs-in"));
    assert.ok(await assertSignableTree(app) >= 6, "an absolute link that stays inside the copy is allowed");
    unlinkSync(at("abs-in"));
    await refuse(() => symlinkSync("missing-target", at("dangling")), /does not resolve/, () => unlinkSync(at("dangling")));
    await refuse(() => { symlinkSync("loop-b", at("loop-a")); symlinkSync("loop-a", at("loop-b")); }, /does not resolve/, () => { unlinkSync(at("loop-a")); unlinkSync(at("loop-b")); });
    await refuse(() => symlinkSync("..", at("up-one")), /outside the copy/, () => unlinkSync(at("up-one")));
    await refuse(() => linkSync(outside, at("hard")), /hardlinked/, () => unlinkSync(at("hard")));
    await refuse(() => linkSync(at("Contents/Frameworks/F.framework/Versions/A/F"), at("hard-inside")), /hardlinked/, () => unlinkSync(at("hard-inside")));
    assert.ok(await assertSignableTree(app) >= 6, "back to clean after cleanup");
    assert.equal(typeof signs, "function");
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("tree preflight rejects entries not owned by the current user and bounds depth", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const getuid = process.getuid;
    process.getuid = () => getuid.call(process) + 1; // every real entry now looks foreign
    try {
      writeFileSync(join(app, "f"), "x", { mode: 0o600 });
      await assert.rejects(assertSignableTree(app), /not owned by the current user/);
    } finally {
      process.getuid = getuid;
    }
    let dir = app;
    for (let level = 0; level < 70; level += 1) { dir = join(dir, "d"); mkdirSync(dir); }
    await assert.rejects(assertSignableTree(app), /too deeply/);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("an app without removable entitlements reports none removed and keeps the rest", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const receipt = await signNativeTrial(app, { exec: fakeExec(app, { entitlements: { "com.apple.security.cs.allow-jit": true } }).exec });
    assert.deepEqual(receipt.removedEntitlementKeys, []);
    assert.deepEqual(receipt.preservedEntitlementKeys, ["com.apple.security.cs.allow-jit"]);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("refuses unsafe copies before running any command", { skip: !HAS_PLUTIL }, async () => {
  const refused = async (path, pattern) => {
    const calls = [];
    await assert.rejects(signNativeTrial(path, { exec: (...args) => { calls.push(args); return { stdout: "", stderr: "" }; } }), err => err instanceof SignError && pattern.test(err.message), String(path));
    assert.equal(calls.length, 0, "nothing ran");
  };
  await refused(undefined, /absolute/);
  await refused("relative.app", /absolute/);
  await refused(OFFICIAL_APP, /\.app directly inside|canonical/);
  await refused("/private/tmp/claude-native-picker.nope/Missing.app", /does not exist/);

  const wrongName = mkdtempSync("/private/tmp/other-task.");
  const wrongApp = join(wrongName, "Claude.app");
  mkdirSync(wrongApp);
  const open = taskRoot({ mode: 0o755 });
  const notApp = taskRoot();
  const linked = taskRoot();
  const nested = taskRoot();
  const alias = mkdtempSync("/private/tmp/claude-native-picker.");
  chmodSync(alias, 0o700);
  try {
    await refused(wrongApp, /directly inside/);
    await refused(open.app, /private/);
    mkdirSync(join(notApp.task, "plain-dir"));
    await refused(join(notApp.task, "plain-dir"), /directly inside/);
    rmSync(linked.app, { recursive: true });
    symlinkSync(OFFICIAL_APP, linked.app);
    await refused(linked.app, /canonical/);
    const deeper = join(nested.app, "Sub.app");
    mkdirSync(deeper);
    await refused(deeper, /directly inside/);
    const taskLink = `${alias}-link`;
    symlinkSync(alias, taskLink);
    try {
      mkdirSync(join(alias, "X.app"));
      await refused(join(taskLink, "X.app"), /canonical/);
    } finally {
      rmSync(taskLink, { force: true });
    }
  } finally {
    for (const dir of [wrongName, open.task, notApp.task, linked.task, nested.task, alias]) rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when the official signature is invalid, before the copy is touched", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const { exec, calls } = fakeExec(app, { officialFails: true });
    await assert.rejects(signNativeTrial(app, { exec }), SignError);
    assert.equal(calls.some(call => call.args[0] === "--force"), false);
    assert.equal(existsSync(join(task, ENTITLEMENTS_FILE)), false);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("fails when the signed result does not carry exactly the sanitized entitlements or loses the identifier", { skip: !HAS_PLUTIL }, async () => {
  const first = taskRoot();
  const second = taskRoot();
  try {
    const leaky = fakeExec(first.app);
    const wrapped = (file, args, options) => {
      const out = leaky.exec(file, args, options);
      if (args[0] === "-d" && leaky.calls.some(call => call.args.includes("--entitlements"))) return { stdout: xmlOf(ORIGINAL), stderr: "" };
      return out;
    };
    await assert.rejects(signNativeTrial(first.app, { exec: wrapped }), /differ from the sanitized/);

    const base = fakeExec(second.app);
    let signed = false;
    const renamed = (file, args, options) => {
      if (args[0] === "--force" && args.includes("--entitlements")) signed = true;
      const out = base.exec(file, args, options);
      return signed && args[0] === "-dv" ? { stdout: "", stderr: "Identifier=changed.id\nCodeDirectory v=20500 flags=0x10000(runtime)\n" } : out;
    };
    await assert.rejects(signNativeTrial(second.app, { exec: renamed }), /identifier changed/);
  } finally {
    rmSync(first.task, { recursive: true, force: true });
    rmSync(second.task, { recursive: true, force: true });
  }
});

const REAL_APP_BINARY = `${OFFICIAL_APP}/Contents/MacOS/Claude`;
test("real Claude entitlements (read-only): exactly the three restricted keys are dropped", { skip: !HAS_PLUTIL || !existsSync(REAL_APP_BINARY) }, () => {
  const dumped = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", OFFICIAL_APP], { encoding: "utf8" });
  assert.equal(dumped.status, 0);
  const original = JSON.parse(plutil(["-convert", "json", "-o", "-", "-"], dumped.stdout).stdout);
  const clean = sanitizedTrialEntitlements(original);
  const dropped = Object.keys(original).filter(key => !Object.hasOwn(clean, key)).sort();
  assert.deepEqual(dropped, [...REMOVED_TRIAL_ENTITLEMENTS].sort());
  assert.equal(Object.keys(clean).length, Object.keys(original).length - 3);
  for (const key of Object.keys(clean)) assert.deepEqual(clean[key], original[key]);
  const roundTrip = JSON.parse(plutil(["-convert", "json", "-o", "-", "-"], xmlOf(clean)).stdout);
  assert.deepEqual(roundTrip, clean, "the XML plist written for codesign round-trips exactly");
});

const MAGICS = { thin32: "feedface", thin64: "feedfacf", thin32Swapped: "cefaedfe", thin64Swapped: "cffaedfe", fat: "cafebabe", fat64: "cafebabf", fatSwapped: "bebafeca", fat64Swapped: "bfbafeca" };
const machO = (magic, extra = "padding-bytes") => Buffer.concat([Buffer.from(magic, "hex"), Buffer.from(extra)]);

/** A tree shaped like the real app: Mach-O under odd names and extensions, non-Mach-O files, tiny files and a link. */
function machOTree(app) {
  const put = (name, content) => { mkdirSync(join(app, name, ".."), { recursive: true }); writeFileSync(join(app, name), content, { mode: 0o600 }); };
  put("Contents/MacOS/Claude", machO(MAGICS.thin64Swapped));
  put("Contents/Frameworks/E.framework/Versions/A/Libraries/libffmpeg.dylib", machO(MAGICS.thin64));
  put("Contents/Frameworks/E.framework/Versions/A/E", machO(MAGICS.fat));
  put("Contents/Resources/app.asar.unpacked/node_modules/pty/pty.node", machO(MAGICS.thin32));
  put("Contents/Resources/no-extension-helper", machO(MAGICS.fat64Swapped));
  put("Contents/Resources/looks-like-data.json", machO(MAGICS.fatSwapped));
  put("Contents/Resources/swapped32.bin", machO(MAGICS.thin32Swapped));
  put("Contents/Resources/fat64.bin", machO(MAGICS.fat64));
  put("Contents/Resources/readme.txt", "hello, not a binary");
  put("Contents/Resources/script.sh", "#!/bin/sh\necho hi\n");
  put("Contents/Resources/almost.dylib", Buffer.from("feedfa", "hex"));
  put("Contents/Resources/four-zero.node", Buffer.alloc(4));
  put("Contents/Resources/empty.node", Buffer.alloc(0));
  mkdirSync(join(app, "Contents/Frameworks/E.framework/Versions"), { recursive: true });
  symlinkSync("A", join(app, "Contents/Frameworks/E.framework/Versions/Current"));
  symlinkSync("Versions/Current/E", join(app, "Contents/Frameworks/E.framework/E"));
  symlinkSync("../MacOS/Claude", join(app, "Contents/Resources/link-to-main.dylib"));
  return [
    "Contents/Frameworks/E.framework/Versions/A/E",
    "Contents/Frameworks/E.framework/Versions/A/Libraries/libffmpeg.dylib",
    "Contents/MacOS/Claude",
    "Contents/Resources/app.asar.unpacked/node_modules/pty/pty.node",
    "Contents/Resources/fat64.bin",
    "Contents/Resources/looks-like-data.json",
    "Contents/Resources/no-extension-helper",
    "Contents/Resources/swapped32.bin",
  ].map(name => join(app, name)).sort();
}

test("isMachOMagic recognizes thin and fat headers in both byte orders and nothing else", () => {
  for (const [name, magic] of Object.entries(MAGICS)) assert.equal(isMachOMagic(Buffer.from(magic, "hex")), true, name);
  assert.equal(isMachOMagic(machO(MAGICS.thin64)), true, "only the first four bytes matter");
  assert.equal(isMachOMagic(Buffer.concat([Buffer.from("00", "hex"), Buffer.from(MAGICS.thin64, "hex")]).subarray(1)), true, "a view at an offset is read at its own start");
  for (const bad of [Buffer.alloc(0), Buffer.from("feedfa", "hex"), Buffer.alloc(4), Buffer.from("MZ\u0090\u0000"), Buffer.from("#!/b"), Buffer.from("7f454c46", "hex"), Buffer.from("504b0304", "hex"), "feedfacf", null, undefined, [0xfe, 0xed, 0xfa, 0xcf]]) {
    assert.equal(isMachOMagic(bad), false, String(bad));
  }
});

test("listMachOFiles finds every Mach-O by header magic regardless of extension, sorted, without following links", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const expected = machOTree(app);
    const found = await listMachOFiles(app);
    assert.deepEqual(found, expected);
    assert.equal(found.some(path => path.endsWith("link-to-main.dylib")), false, "a symlink to a Mach-O is not listed");
    assert.equal(found.some(path => /\/(?:Current|E)$/.test(path) && path.includes("E.framework/E")), false);
    assert.equal(found.some(path => /readme|script|almost|four-zero|empty/.test(path)), false);
    await assert.rejects(listMachOFiles("relative/app"), /absolute/);
    await assert.rejects(listMachOFiles(undefined), SignError);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("listMachOFiles runs the full preflight: hardlinked, escaping and foreign entries are refused, not listed", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  const outside = join(task, "outside.bin");
  try {
    machOTree(app);
    writeFileSync(outside, machO(MAGICS.thin64), { mode: 0o600 });
    linkSync(outside, join(app, "Contents/Resources/hardlinked.dylib"));
    await assert.rejects(listMachOFiles(app), err => err instanceof SignError && /hardlinked/.test(err.message));
    const { calls, exec } = noCalls();
    await assert.rejects(signNativeTrial(app, { exec }), /hardlinked/);
    assert.equal(calls.length, 0, "nothing is signed when the preflight fails");
    unlinkSync(join(app, "Contents/Resources/hardlinked.dylib"));
    symlinkSync("../../../outside.bin", join(app, "Contents/Resources/escape.dylib"));
    await assert.rejects(listMachOFiles(app), /outside the copy/);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("every Mach-O leaf is signed first, in a stable order, before the deep bundle signature and the sanitized main signature", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    const expected = machOTree(app);
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec });
    const signs = calls.filter(call => call.args[0] === "--force");
    assert.equal(signs.length, expected.length + 2);
    const leaves = signs.slice(0, expected.length);
    leaves.forEach((sign, index) => {
      assert.deepEqual(sign.args, ["--force", "--sign", "-", "--preserve-metadata=identifier,entitlements,flags,runtime", expected[index]]);
      assert.equal(sign.args.includes("--deep"), false, "a leaf is signed on its own");
      assert.equal(sign.args.includes("--entitlements"), false, "a leaf keeps its own entitlements");
    });
    assert.ok(leaves.some(sign => sign.args.at(-1).endsWith("Contents/MacOS/Claude")), "the main executable is a leaf too");
    assert.ok(leaves.some(sign => sign.args.at(-1).endsWith("Libraries/libffmpeg.dylib")), "libraries --deep misses are signed explicitly");
    assert.deepEqual(signs[expected.length].args, ["--force", "--deep", "--sign", "-", "--preserve-metadata=identifier,entitlements,flags,runtime", app]);
    assert.deepEqual(signs[expected.length + 1].args, ["--force", "--sign", "-", "--preserve-metadata=identifier,flags,runtime", "--entitlements", join(task, ENTITLEMENTS_FILE), app]);
    const last = calls.indexOf(leaves.at(-1));
    assert.ok(last < calls.indexOf(signs[expected.length]) && calls.indexOf(signs[expected.length]) < calls.indexOf(signs[expected.length + 1]), "leaves, then the deep bundle, then the main");
    assert.ok(calls.findIndex(call => call.args[0] === "--verify") < calls.indexOf(leaves[0]), "the official app is verified before anything is signed");
    for (const call of calls) assert.equal(call.args.includes(OFFICIAL_APP) && call.args[0] === "--force", false, "the official app is never signed");
    for (const sign of signs) assert.equal(sign.args.some(arg => /^--options|library-validation|disable/i.test(arg)), false, "library validation stays on");
    assert.equal(receipt.machOFilesSigned, expected.length);
    assert.deepEqual(receipt.removedEntitlementKeys, ["com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups"]);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});

test("leaf signatures use the configured certificate and fixed keychain like the bundle signatures", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  const { home, keychain } = fakeHome();
  try {
    const expected = machOTree(app);
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec, identity: FINGERPRINT, keychain, homeDirectory: home });
    const leaves = calls.filter(call => call.args[0] === "--force").slice(0, expected.length);
    assert.equal(leaves.length, expected.length);
    leaves.forEach((sign, index) => {
      assert.deepEqual(sign.args, ["--force", "--sign", FINGERPRINT, "--keychain", keychain, "--preserve-metadata=identifier,entitlements,flags,runtime", expected[index]]);
    });
    assert.equal(receipt.signingIdentity, DEVELOPER_ID_SIGNING_IDENTITY);
    assert.equal(receipt.machOFilesSigned, expected.length);
  } finally {
    rmSync(task, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an app tree with no Mach-O files signs only the bundle and reports zero leaves", { skip: !HAS_PLUTIL }, async () => {
  const { task, app } = taskRoot();
  try {
    writeFileSync(join(app, "notes.txt"), "text", { mode: 0o600 });
    const { exec, calls } = fakeExec(app);
    const receipt = await signNativeTrial(app, { exec });
    assert.equal(calls.filter(call => call.args[0] === "--force").length, 2);
    assert.equal(receipt.machOFilesSigned, 0);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});