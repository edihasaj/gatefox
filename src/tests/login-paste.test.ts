import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { forwardPastedCallback, pastedCallback } from "../login-paste.js";

const authorize = "https://auth.openai.com/api/accounts/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A57253%2Fauth%2Fcallback&state=s";

test("only this sign-in's loopback callback is accepted from a paste", () => {
  assert.equal(pastedCallback("http://127.0.0.1:57253/auth/callback?code=ac.2&state=s", authorize), "http://127.0.0.1:57253/auth/callback?code=ac.2&state=s");
  assert.equal(pastedCallback("  http://localhost:57253/auth/callback?code=c\\&state=s  ", authorize), "http://127.0.0.1:57253/auth/callback?code=c&state=s", "markdown-escaped & and localhost");
  for (const line of ["http://127.0.0.1:9999/auth/callback?code=c", "http://evil.test:57253/auth/callback?code=c", "https://127.0.0.1:57253/auth/callback?code=c",
    "http://127.0.0.1:57253/other?code=c", "http://127.0.0.1:57253/auth/callback", "not a url"]) assert.equal(pastedCallback(line, authorize), undefined, line);
});

test("the first valid pasted line is delivered once and later lines are ignored", async () => {
  const input = new PassThrough(); const delivered: string[] = [];
  const stop = forwardPastedCallback(authorize, input, async url => { delivered.push(url); });
  input.write("hello\n"); input.write("http://127.0.0.1:57253/auth/callback?code=one&state=s\n"); input.write("http://127.0.0.1:57253/auth/callback?code=two&state=s\n");
  await new Promise(done => setImmediate(done)); stop();
  assert.deepEqual(delivered, ["http://127.0.0.1:57253/auth/callback?code=one&state=s"]);
});
