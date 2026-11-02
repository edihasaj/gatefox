---
summary: 'Local stable-provider maintenance: isolated candidates, generated Codex pins, CLI protocol checks, and safe source promotion.'
read_when:
  - Updating Codex, Claude or Copilot compatibility
  - Changing SDK source pins, feature schemas or provider update scheduling
  - Investigating a blocked provider maintenance run
---

# Provider updates

The build host can validate and update stable provider compatibility manually.
Codex changes reach installed gateways through the normal verified gateway
release. Claude and Copilot use private verified installations on that host;
new processes select the current installation and running sessions keep theirs.

```text
Official stable releases
          ↓
Private candidate checkout and CLI installations
          ↓
Gateway tests + CLI handshakes + patched Codex build and actual gateway mock turn
          ↓ pass                         ↓ fail
Generated pins and CLI paths      Last verified source and CLI paths stay
          ↓
Normal gateway release and idle activation
```

| Provider | Discovery | Compatibility gate |
| --- | --- | --- |
| Codex gateway SDK | Official stable GitHub release, tag resolved to its immutable commit | Archive SHA-256, sequential gateway patches, locked Rust build, all 33 identity/compaction/queue/client-tool/role-context/cache/background-completion regressions, release executable |
| Claude Code | Official npm `latest` stable release and exact-version metadata | SHA-512 archive integrity, private native installation, version, required public flags, actual stream-json control initialization using the gateway's complete CLI arguments |
| GitHub Copilot | Official npm `latest` stable release and exact-version metadata | SHA-512 archive integrity, private installation, version, required public flags, actual gateway RPC framing and protocol 3 handshake |
| API-only providers | No local provider executable | Existing translation and transport tests; caller models, endpoints and credentials stay unchanged |

Claude and Copilot have no manually maintained version whitelist. Their validation
record in `provider-compatibility.json` documents tested versions. On promotion,
private immutable installations go under
`~/.local/share/harness-gateway/provider-tools/<integration-contract>/installs`, and an atomic
`current.json` selects both versions. The gateway verifies the whole dependency
tree before selecting a new process. A changed managed installation fails closed.
An installation without a managed entry continues to use PATH.

The job never replaces global CLIs or redistributes their packages. Official
package installers run inside the private candidate prefix and HOME, without
inherited provider credentials or Node injection variables. Provider licenses stay
with those private installations. Runtime authentication keeps each account's
existing directory; validation homes are never reused for real requests. CLI
self-updates are disabled in gateway-owned launches, including sign-in.
The integration contract derives from the gateway's CLI adapter source files.
Older gateway releases retain their own verified installations when those adapters
change; testing an unreleased adapter cannot change their selected tools.

The signed app engine and native relay are separate compatibility boundaries.
This job updates the gateway's patched Codex SDK. It does not replace or re-sign
the app's native executable, or automatically expand native sharing and relay
allowlists. Those depend on signature, ownership and transport checks described
in [architecture](architecture.md) and [native remote](native-remote.md).

## Commands

Run `npm ci` and `npm run build` on the Apple Silicon build host first. Rust and
the usual release build tools must already be available.

```sh
npm run providers:check
npm run providers:update
npm run providers:update -- --commit
npm run providers:schedule -- status
npm run providers:schedule -- uninstall
```

`providers:check` prepares and validates a candidate. `providers:update` also
promotes the five generated files and managed CLI installations when source HEAD
is unchanged and the checkout is still clean. `--commit` uses `committer` with
those explicit source paths.
It never pushes, merges, publishes a release, dispatches hosted CI or restarts
a gateway. A dirty checkout refuses automatic promotion.

The former standalone daily developer LaunchAgent is retired. `install` refuses
to create it, preserving the single signed app-owned background item. Provider
compatibility builds remain manual; model-family discovery still runs
automatically inside the app service. Manual maintenance leaves a dirty checkout
or a different branch alone and uses the private-file lock. It creates no GitHub
Actions trigger. See the [CI cost policy](ci-cost-policy.md).

The fixed outcome and phase are in `.state/provider-maintenance/latest.json`;
the schedule prints only safe outcomes in `schedule.log`. A failed validator also
records bounded structured facts when available:

| Field | Saved information |
| --- | --- |
| `failureReason` | `nonzero_exit`, `timeout`, `output_limit`, `spawn_error`, or `cancelled`; the first cause is retained. |
| `exitCode`, `signal` | Numeric exit status and an allowed operating-system signal name. |
| `failureFiles`, `failureLocations` | Existing candidate-relative test files and their line numbers, with optional columns. |
| `failureTypes`, `compilerCodes` | Allowed Node test failure classes and Rust or TypeScript compiler codes. |
| `testTotals` | Numeric TAP or spec-reporter summary counts. |

Locations are restricted to the candidate's `dist/tests/*.test.js` and
`scripts/tests/provider-*.test.mjs` files. Absolute paths and file URLs are reduced
to relative paths only after containment checks. Arrays, paths, line buffers, and
counts are bounded. Metadata is validated again before it reaches the report,
including errors supplied by test doubles.

Raw messages, test titles, assertion values, stack traces, command arguments,
environment values, and provider output are not retained. Failed candidates stay
under that directory for inspection. Validation
uses no subscription inference or copied authentication. Handshakes prove CLI
interfaces, not model behavior or billing.
Maintenance limits the source suite to four concurrent fixture files to avoid
host-load-dependent lease and startup failures. The ordinary runner keeps its
eight-file cap; `GATEWAY_TEST_CONCURRENCY` can lower it to any value from 1 to 8.

An upstream incompatibility is a blocked update, not permission to weaken
permissions or remove tests. The job retains the existing pins and retries on the
next run. Compatible releases need no manual version or hash edits. A breaking
patch, protocol, schema or safety change still requires implementation work.
SDK builds retain immutable source paths through the updater's `--build-root`
selection, while still verifying the archive, complete tree and build outputs.
A private build lock serializes their temporary compaction-test isolation.
After an interruption, only the authenticated original or reduced aggregator can
be recovered automatically; other changes remain a blocked update.

## Generated SDK inputs

`src/gateway-sdk-pin.json` is the single upstream identity used by build scripts
and the compiled runtime. The candidate derives workspace lock repairs and test
aggregator hashes from the selected immutable source. A changed test boundary
blocks the candidate; it never silently skips the regression suite.

`src/gateway-feature-schema-data.json` derives strict feature tables and nested
fields from upstream `config.schema.json`. Unsupported schema shapes block the
candidate. Network limits retain their existing fail-closed handling.
`src/gateway-sdk-build-pins.ts` contains derived source and patch hashes; generate
it with `npm run sdk:pins` and check it with:

```sh
node scripts/sync-gateway-sdk-pins.mjs --check
npm run providers:test
```

The other generated files are the adapter integration contract and
`provider-compatibility.json`. A cached successful
candidate is valid only for the same source revision, releases, generated bytes,
SDK receipt/binary and CLI dependency trees. Corrupt caches trigger validation
again. A durable source-promotion journal recovers interrupted writes while
preserving any intervening user edit. Source promotion never overwrites other work. Installation and
runtime receipt checks still require exact versions, digests and gateway patch
capabilities for the selected release.
