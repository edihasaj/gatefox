import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dropGatewayCodexHome, isGatewayInternalHome, wrapperHomeGuard } from "../native-home-env.js";
import { chatRejection } from "../providers/chat-rejections.js";

const state = "/Users/x/Library/Application Support/Subscription Gateway/state";
const home = "/Users/x";

test("a CODEX_HOME inside the gateway's state or host roots is gateway-internal; the native home and others are not", () => {
  for (const internal of [`${state}/desktop-generations/shared-v1-abc/desktop-engine`, state, `${home}/.local/state/gw-exec/f90c`, `${home}/.local/state/gw-ssh/1a2b`]) {
    assert.equal(isGatewayInternalHome(internal, state, home), true, internal);
  }
  for (const kept of [`${home}/.codex`, "/tmp/isolated-native-home", `${state}-other/x`, `${home}/.local/state/gw-execution`, undefined, ""]) {
    assert.equal(isGatewayInternalHome(kept, state, home), false, String(kept));
  }
  const env: NodeJS.ProcessEnv = { CODEX_HOME: `${state}/desktop-generations/g/desktop-engine`, PATH: "/bin" };
  assert.equal(dropGatewayCodexHome(env, state, home), true);
  assert.deepEqual(env, { PATH: "/bin" });
  const native: NodeJS.ProcessEnv = { CODEX_HOME: `${home}/.codex` };
  assert.equal(dropGatewayCodexHome(native, state, home), false);
  assert.equal(native.CODEX_HOME, `${home}/.codex`);
});

test("the wrapper guard unsets only a gateway-internal CODEX_HOME, under a real POSIX shell", () => {
  const root = mkdtempSync(join(tmpdir(), "home-guard-"));
  const quotedState = join(root, "it's state");
  const script = join(root, "wrapper");
  writeFileSync(script, "#!/bin/sh\n" + wrapperHomeGuard(quotedState, root) + 'printf "%s" "${CODEX_HOME-unset}"\n');
  chmodSync(script, 0o700);
  const run = (codexHome?: string) => execFileSync(script, { env: { PATH: "/usr/bin:/bin", ...(codexHome === undefined ? {} : { CODEX_HOME: codexHome }) }, encoding: "utf8" });
  assert.equal(run(join(quotedState, "desktop-generations/g/desktop-engine")), "unset");
  assert.equal(run(join(root, ".local/state/gw-exec/abc")), "unset");
  assert.equal(run(join(root, ".codex")), join(root, ".codex"));
  assert.equal(run(), "unset");
});

test("Chat Completions 400s get a fixed reason and an allowlisted parameter, never their text", () => {
  // vLLM's actual bodies from the local Qwen server on 30 October 2026.
  assert.deepEqual(chatRejection({ error: { message: "When using `tool_choice`, `tools` must be set. (parameter=tool_choice)", type: "BadRequestError", param: "tool_choice", code: 400 } }),
    { reason: "tool_choice_without_tools", param: "tool_choice" });
  assert.deepEqual(chatRejection({ error: { message: "This model's maximum context length is 262144 tokens. However, you requested 0 output tokens and your prompt contains at least 262145 input tokens.", type: "BadRequestError", param: "input_tokens", code: 400 } }),
    { reason: "context_length", param: "input_tokens" });
  assert.equal(chatRejection({ error: { message: "max_tokens must be at least 1", param: "max_tokens" } }).reason, "output_tokens");
  assert.equal(chatRejection({ error: { message: "Conversation roles must alternate user/assistant" } }).reason, "message_format");
  assert.deepEqual(chatRejection({ error: { message: "secret prompt text", param: "my_secret_field" } }), { reason: "unknown" }, "an unknown parameter name is not kept");
  assert.deepEqual(chatRejection(undefined), { reason: "unknown" });
});
