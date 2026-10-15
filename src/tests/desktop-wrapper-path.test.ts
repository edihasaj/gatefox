import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { isOwnWrapperPath } from "../desktop-wrapper-path.js";
import { ownWrapper } from "../mac-desktop.js";
import { desktopEnvironment } from "../desktop-launch.js";

const FORCE = "CODEX_APP_SERVER_FORCE_CLI"; const PATH_KEY = "CODEX_CLI_PATH";
const state = "/state";
const name = "desktop-wrapper-0123456789abcdef";

/** Every spelling of a wrapper path, with the verdict the one shared rule must give. */
const spellings: Array<[string, string, boolean]> = [
  ["the wrapper itself", join(state, name), true],
  ["the same name in another directory", join("/other", name), false],
  ["the same name in a subdirectory", join(state, "sub", name), false],
  ["the same name in a sibling of the state directory", join("/state-x", name), false],
  ["a relative name", name, false],
  ["a name that climbs back through ..", `${join(state, "x")}/../${name}`, false],
  ["a name that goes through a dot segment", `${state}/./${name}`, false],
  ["a trailing separator", join(state, name) + "/", false],
  ["a suffix after the hash", join(state, name + ".sh"), false],
  ["a prefix before the word", join(state, "not" + name), false],
  ["a short hash", join(state, "desktop-wrapper-0123"), false],
  ["a long hash", join(state, "desktop-wrapper-0123456789abcdef0"), false],
  ["a non-hex hash", join(state, "desktop-wrapper-zzzzzzzzzzzzzzzz"), false],
  ["an uppercase hash", join(state, "desktop-wrapper-0123456789ABCDEF"), false],
  ["an uppercase word", join(state, "DESKTOP-WRAPPER-0123456789abcdef"), false],
  ["the empty value", "", false],
];

test("the wrapper rule takes an absolute, normalised path directly in the state directory and nothing else", () => {
  for (const [what, path, ours] of spellings) assert.equal(isOwnWrapperPath(path, state), ours, what);
});

test("the wrapper rule resolves the state directory it is given but never the path it is asked about", () => {
  // The caller's state directory arrives from config already resolved, or from a spelling that only needs
  // resolving: either way, it is the directory the path must sit directly in.
  assert.equal(isOwnWrapperPath(join(state, name), state + "/"), true, "a trailing separator on the state directory is the same directory");
  const relative = "gateway-relative-state";
  assert.equal(isOwnWrapperPath(join(resolve(relative), name), relative), true, "a relative state directory is the resolved one");
  assert.equal(isOwnWrapperPath(join(relative, name), relative), false, "a relative path is still not an absolute one");
});

test("the launcher drops a legacy FORCE_CLI only for a path the same rule accepts", () => {
  const wrapper = join(state, "desktop-wrapper-fedcba9876543210");
  const kept = (path: string) => desktopEnvironment({ [PATH_KEY]: path, [FORCE]: "1" }, wrapper, "/tmp/gateway.json")[FORCE];
  assert.equal(kept(wrapper), undefined, "the wrapper this launch writes");
  assert.equal(kept(join(state, name)), undefined, "an older wrapper beside it");
  for (const [what, path, ours] of spellings) {
    if (path === wrapper) continue;
    assert.equal(kept(path), ours ? undefined : "1", what + (ours ? " is ours to drop" : " belongs to the user"));
  }
});

/**
 * The registration half of the rule is the same spelling test plus what the entry actually is, so on a session
 * that answers "regular file, owned by me" the two must agree on every spelling.
 */
test("registration ownership is the shared rule plus a file-type and uid check, never a second spelling rule", { skip: process.platform !== "darwin" }, async () => {
  const mine = async () => ({ isFile: () => true, isSymbolicLink: () => false, uid: process.getuid?.() ?? 0 });
  for (const [what, path, ours] of spellings) {
    assert.equal(await ownWrapper(state, path, mine), ours, what);
    assert.equal(await ownWrapper(state, path, mine), isOwnWrapperPath(path, state), what + ": the two paths through the rule agree");
  }
});
