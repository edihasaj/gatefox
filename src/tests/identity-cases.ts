import nodeTest, { type TestContext } from "node:test";

/**
 * The two provider ids a gateway chat can be saved with: the gateway's own, which every release so far writes, and the
 * native identity a later release writes. A gateway chat must behave the same under both, so the tests that read a saved
 * gateway chat or a gateway engine's notification run once per identity. Requests the router sends still carry the
 * gateway's own id in this release; tests assert those with the literal.
 */
export const gatewayIdentities = [
  { name: "legacy", provider: "subscription_gateway" },
  { name: "openai", provider: "openai" },
] as const;
export type GatewayIdentityCase = typeof gatewayIdentities[number];
export const legacyProvider = "subscription_gateway";

type Body = (t: TestContext) => unknown | Promise<unknown>;
/**
 * A `test` that registers its body once per identity, titled with the identity's name, and calls `use` with that identity
 * before the body runs. Tests in a file run one at a time, so a file can keep the current identity in a module variable.
 */
export function identityTest(use: (identity: GatewayIdentityCase) => void) {
  function test(name: string, body: Body): void;
  function test(name: string, options: { timeout?: number; skip?: boolean | string }, body: Body): void;
  function test(name: string, second: Body | { timeout?: number; skip?: boolean | string }, third?: Body): void {
    const body = (typeof second === "function" ? second : third)!; const options = typeof second === "function" ? {} : second;
    for (const identity of gatewayIdentities) nodeTest(`${name} (${identity.name})`, options, async t => { use(identity); await body(t); });
  }
  return test;
}
