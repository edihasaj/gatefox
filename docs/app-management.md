---
summary: 'Native setup wizard, account connections, model selection, and the private app-management protocol.'
read_when:
  - Changing first-run setup or connection management in the macOS app
  - Changing account sign-in, API-key storage, model selection, or app configuration writes
  - Testing the wizard against an isolated gateway
---

# Setup and connections

A new installation opens the setup wizard. An existing valid configuration opens
the normal app and its configured connections. The wizard can also be opened
from **Add connection** or Settings.

The wizard guides the user through choosing a provider, connecting the account or
server, selecting models, and reviewing the connection. It stages changes
privately until **Apply connection** is selected. First setup then uses the
gateway's existing service and desktop-registration commands. The final screen
reports those results separately and offers another setup attempt if needed.
Initial desktop registration takes effect when Codex is quit and reopened once.

## Connecting accounts and servers

Claude and Copilot can use the vendor CLI's existing sign-in when the user
explicitly selects that option. A separate account uses its own authentication
directory. New browser sign-in uses the official CLI's subscription login flow.
Missing provider CLIs have links to their installation instructions.

Codex uses the gateway's separate Sign in with ChatGPT registration. It does not
copy the native Codex account's authentication. An optional account email restricts
the new registration to that account, and reconnecting a stored account retains
its verified identity restriction. Codex authentication and catalog discovery
use HTTP; they do not require a separate Codex CLI installation.

To add an account that is also used natively, add a separate Codex connection and
sign in with that account's email. Each Mac gets its own gateway registration;
native credentials and rotating refresh tokens are not copied between machines.
The account-qualified gateway aliases remain distinct from the native models.
When adding a second Codex account, preserve the previous bare-model route by
explicitly designating the existing account with `defaultForBareModels: true`
unless the operator requests a different default. Otherwise a formerly unique
bare subagent model can become ambiguous. See [account routing](architecture.md).
Native picker selection is separate from each gateway connection's enabled
models; see [native picker selection](app-server.md#native-picker-selection).

Responses, Anthropic, and OpenAI-compatible servers accept a server URL and an
API key. HTTP is limited to loopback. An unauthenticated local server can leave
the key empty; the app stores an unused local credential to satisfy the existing
gateway configuration contract. HTTPS servers require a supplied key.
Servers that do not expose a model catalog support explicit model IDs.

Named API presets cover Grok/xAI, OpenCode Console, OpenCode Go and OpenRouter.
They use the existing API transports and credential storage. OpenCode connections
select the model's native API format. See [API providers](api-providers.md) for
endpoints, model selection and the distinction between API credits and Grok
subscription usage.

New configurations prefer loopback port 3457 and select an available loopback
port when it is already occupied. Existing configurations retain their port.
Creating a connection does not restart an existing service.

## Existing connections

For opt-in updates of only the families already selected, use **Automatic latest
models**. New unrelated models stay visible but unchecked, and older chat routes
remain usable after leaving the picker. See [automatic latest models](auto-latest-models.md)
for the five-minute schedule, provider dates, baseline and safety rules.

The host view identifies **This Mac** and its computer name. Its connections and
model selections belong to that Mac. A Codex SSH chat uses the gateway on the
remote execution host, not the gateway on the Mac displaying the chat.

Connections shows each provider's label, configured model count, and available
authentication evidence. Saved credentials are distinguished from a successful
model-catalog check. Catalog checks do not send inference prompts.

Users can check a connection, refresh its catalog, choose enabled models, rename
it, reconnect an account, or replace an app-managed API key. Externally managed
credentials remain outside these editing controls. Removing a connection keeps
its credentials and requires confirmation; the last provider cannot be removed.

Use **Move up** and **Move down** on a connection to save a custom order, or
choose **Move to top** from its menu. The first connection appears first in the
app and among gateway provider groups in the model catalog. Native model rows
retain their separate position. Ordering
does not change the selected model, account routing, or the designated account
for bare subagent model names. It applies on that gateway host, so reorder each
host separately when using several Macs. Shared clients display their host's
order without local editing controls.

**Native GPT fallback models** separately controls the local adapter's native fallback
rows: First, Last, or Hidden. Last keeps them visible below the gateway groups.
Hidden removes them only from the normal picker; it does not disable native
chats, explicit model requests, or account authentication. The existing native
model selection stays unchanged. Current registered adapters apply a saved
change on the next picker refresh; older adapters first need normal reconnection
to load this behavior. The app never restarts active chats to apply a preference.

Shared clients may edit this local native picker preference even though their
remote provider catalog is read-only. It belongs to the execution host's own
configuration, not to the shared inference host. SSH chats use the remote Mac's
preference. See [native picker placement](app-server.md#native-picker-selection).

Refreshing a catalog does not change enabled routes. Applying a selection keeps
every existing alias and its metadata for retained upstream models. A private
alias ledger reserves retired route identities, so another model or account
cannot silently take an alias referenced by saved chats.

Existing Grok subscription connections are supported without a new login or
catalog-discovery flow. Their configured models can be disabled and re-enabled
without losing their aliases or metadata. Refresh and reconnect are unavailable;
the app does not infer successful authentication from saved routes.

## Shared-gateway clients

A configuration with `clientOnly: true` shows a read-only shared catalog instead
of local connection editors. The source name comes from the serving gateway,
not the client's computer name or a cached catalog. Provider credentials and
model-selection changes remain on that host.

Inspection uses the existing private `stateDirectory/client-token` to request
`GET /v1/gateway-info` through the configured loopback port or SSH forward. This
authenticated endpoint returns only protocol version, serving hostname, provider
IDs/labels/types, and selected model IDs/labels. It exposes no credentials,
configuration paths, or authentication evidence and sends no inference request.
An unavailable, incompatible, or invalid response clears the shared catalog and
offers a retry; it never displays a previous host's catalog as current.
The read has a three-second network deadline and a 1 MiB body limit, with at most
32 providers and 256 models per provider. A catalog exceeding those protocol
bounds is refused whole, not silently truncated.

## Configuration and credential ownership

The app reads the configuration used by the managed service or the explicit file
selected in Advanced settings. Each edit carries the revision that was reviewed.
A changed revision is refused under the configuration lock and must be refreshed.
Unknown configuration fields and unrelated providers are preserved. A private
backup is saved before a changed existing configuration is atomically replaced.
An unchanged selection leaves the original file untouched.

New connections own private credential and authentication directories under the
gateway state directory. Configuration, draft, backup, and credential files use
owner-only permissions. Directory ancestry and ownership are checked before
writes, and symlink escapes are refused. No configuration edit writes native
Codex authentication, model choices, agent instructions, roles, or permissions.

Cancellation stops the app-owned management process and its attached helpers.
The wizard does not reuse an earlier failed or cancelled draft. Uncommitted
private state may remain on disk; cancelling does not delete existing
credentials or publish its staged routes.

## Private management transport

The app launches its bundled Node runtime with
`Contents/Resources/management/dist/app-management.js`. One bounded JSON request
travels over standard input and one typed JSON response returns on standard
output. API keys are never command arguments or environment values. Child
output and raw exceptions are not displayed or logged.

The operations are `inspect`, `prepare`, `authenticate`, `discover`, `commit`,
`models`, `rename`, `reorder`, `native-picker`, `auto-latest`, `auto-latest-check`,
`remove`, and `discard`. `auto-latest` saves a boolean `enabled` with the reviewed
revision, capturing today's selected families without changing model selection.
`auto-latest-check` uses the reviewed revision to run one metadata-only check.
Both report the effective policy and bounded check/scheduling status.
Reordering sends
`providerIds`, an exact permutation of all local connection IDs, together with
the reviewed configuration revision. Duplicate, missing, or unknown IDs and
outdated revisions are refused. An unchanged order does not rewrite the file.
`native-picker` saves `nativeModelPickerPlacement` with the reviewed revision,
using the same private backup and atomic save. It preserves all other fields
and providers. Saving the effective default `first` to an unchanged implicit
default does not rewrite the configuration.
The TypeScript types in
`src/app-management/types.ts` and Swift types in `GatewayManagementTypes.swift`
define the protocol. Requests are limited to 128 KiB and responses to 2 MiB.
Ordinary operations have a thirty-second deadline; interactive authentication
has fifteen minutes. Input, output, cancellation, and timeout cleanup are bounded.

The management module set is packaged with the app independently of the existing
inference release. Updating the control panel preserves the installed gateway
command, running daemon, native components, and their release ownership.
Validation and discovery use the verified engine libraries bundled with the app.
This preserves registered transport options such as Tailnet routes, while new
wizard inputs retain the stricter HTTPS-or-loopback URL checks. A packaged app
with missing or invalid engine libraries fails closed. Source-only tests use the
repository's local libraries.

## Verification

Run the normal gateway gate and the native checks:

```sh
npm run build
npm run check
npm test
npm run app:test
npm run app:e2e -- --output /tmp/harness-wizard-verification
npm run app:e2e:connections -- --output /tmp/harness-connections-verification
```

The end-to-end runner uses a real isolated gateway and a loopback model server.
It checks creation, discovery, selected-model persistence, actual Responses
translation, API-key replacement, concurrent-edit refusal, and unchanged native
account sentinels. No paid provider inference is used.

The connections runner checks all four subscription/API provider fixtures,
Grok model-selection roundtrips, an authenticated shared catalog, read-only
client behavior, and clearing the catalog when its gateway becomes unavailable.
It also supports `--serve-fixture` for host/client GUI verification.

For rendered first-run verification, start the same fixture with
`--serve-fixture`. Its JSON metadata identifies the new private home, target
configuration, and local server. Launch the built app with:

```sh
open -n "/absolute/path/Harness Gateway.app" --args \
  --config /absolute/fixture/home/settings/gateway.json \
  --data-home /absolute/fixture/home
```

Use the actual `configPath` and `home` printed by the fixture. Explicit launches
have separate gateway-selection preferences. The data home must be a private directory owned
by the current user, and the configuration must be inside it. Invalid, duplicate,
or malformed options fail before the app loads normal user state.

The GUI fixture substitutes only the macOS service-registration boundary. Its
service command starts the real gateway against the configuration saved by the
wizard. It does not register a LaunchAgent or change the live desktop adapter.
After testing, quit the fixture app and stop the fixture coordinator, then
reopen the normal installed app.

## Verified on October 23, 2026

The real native Connections screen displayed the four-provider host fixture,
including Grok, and identified the local Mac and SSH execution scope. The Grok
model sheet offered configured checkboxes without discovery or manual model
inputs. Disabling, applying, reopening, and re-enabling a model restored the
configuration's exact original SHA-256 digest.

The client-only fixture displayed the actual serving hostname and all four
providers without credential controls. Stopping only the fixture gateway and
refreshing removed the old provider rows and displayed the unavailable/retry
state. These checks used local mocks, not paid inference or live service changes.
Automated coverage also checks duplicate Grok aliases with distinct metadata,
private-home isolation, bounded hostile shared responses, and obsolete refreshes
after same-path cancellation or an A-to-B-to-A configuration switch.

## Verified on October 18, 2026

The MacBook GUI completed a fresh local-server setup, discovered two models,
saved one selected model, and reached the ready screen. The configuration did
not exist before Apply. A real Responses request through that saved gateway
returned the local test model's response.

The same GUI test changed the configured selection to two models, replaced its
private API key, renamed the connection, added and removed a second connection,
and reopened the saved configuration without repeating first-run setup. The
last-provider removal guard was checked.

The corrected app was installed on Studio and MacBook. Their installed native
management bridge loaded the real configurations: two providers and twenty
models on Studio, three providers and twenty-one models on MacBook. Discovery
through the MacBook's registered Tailnet Qwen connection succeeded. Configuration
digests and running gateway PIDs remained unchanged across the app updates.

Browser login wrappers, cancellation, private authentication homes, and identity
restrictions have isolated automated coverage. The live account checks reused
the existing registrations and did not perform fresh browser consent or paid
provider inference. The MacBook screen locked after the GUI walkthrough;
the final transport compatibility correction was checked through the installed
native bridge and management backend.
