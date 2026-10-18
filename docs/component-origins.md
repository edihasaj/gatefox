---
summary: 'How a release reuses two separately authenticated original component archives.'
read_when:
  - Changing scripts/release-components.mjs or scripts/build-release.mjs reuse flags
  - Publishing a release that reuses the native relay or the gateway SDK
  - Debugging a gateway SDK that refuses to load after a component reuse
---

# Component origins

A release can carry a component from an earlier published bundle. The bundle that
supplies a component is its **origin**, and the origin is recorded per component.

```mermaid
flowchart LR
  A["SDK bundle 0.4.7<br/>--reuse-components-from + --components-sha256"] -->|gatewaySdk only| C["release stage<br/>package/release.json"]
  B["relay bundle 0.5.0<br/>--reuse-native-from + --native-sha256"] -->|native only| C
  D["this checkout<br/>fresh build"] -->|runtime, scripts, JavaScript| C
```

`package/release.json` keeps the legacy top-level `bundleVersion` / `bundleSha256`,
which name the SDK bundle, and adds `origin` to each component so the relay can point
at its own archive:

```json
{ "reusedComponents": { "bundleVersion": "0.4.7", "bundleSha256": "…",
  "components": {
    "gatewaySdk": { "buildVersion": "0.4.7", "sourceSha256": "…",
      "origin": { "bundleVersion": "0.4.7", "bundleSha256": "…" }, "files": [] },
    "native": { "buildVersion": "0.5.0", "sourceSha256": "…",
      "origin": { "bundleVersion": "0.5.0", "bundleSha256": "…" }, "files": [] } } } }
```

## Rules

- Each archive is authenticated on its own: whole-archive SHA-256, safe tar entries,
  the complete checksum manifest, the six component files, its own upstream pins,
  release profile, source digest, and (for the gateway SDK) its capability. The
  native binary bytes are authenticated by the whole-archive checksum and the
  complete manifest; the relay's original receipt carries no `binarySha256` field,
  so only the SDK's receipt hash is additionally checked against its archived
  binary. Only the named component paths are taken from it; two origins can never
  supply the same path.
- An archive that already reused the selected component is refused. Reuse the
  bundle that built it, so the receipt's bytes stay the original's.
- `--reuse-native-from` requires `--native-sha256`, both `--with-native` and
  `--with-gateway-sdk`, and the full SDK reuse pair `--reuse-components-from` and
  `--components-sha256`: the override means two original archives, so it never
  pairs with a freshly built gateway SDK. It also excludes `--fresh-native`.
- Runtime resolution (src/gateway-sdk-runtime.ts): a component `origin` that is
  complete and valid wins; a missing `origin` falls back to the parent receipt, so
  releases built before this field still verify. A present but partial or malformed
  `origin` fails closed, with no fallback.
- Receipts and binaries are copied byte for byte. Re-copied files are re-hashed
  against the verified digest before they reach the stage.
