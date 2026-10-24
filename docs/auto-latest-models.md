---
summary: 'Opt-in automatic updates for selected model families, bounded catalog polling and historical chat routes.'
read_when:
  - Enabling or changing automatic latest-model selection.
  - Changing model discovery, family matching, timestamps or picker visibility.
  - Investigating the service's five-minute model refresh or a model that stayed disabled.
---

# Automatic latest models

Connections offers an **Automatic latest models** switch and **Check now**.
Enabling it captures the families of the models already selected on this
execution host, without changing today's selection. The native fallback
selection is captured separately. Turning it off freezes the current selection;
it does not bring older versions back or disable an account.

```text
Current selected families + known catalog baseline
                         ↓
Five-minute metadata-only checks
                         ↓
New ID in a selected family and provably newer?
             yes                         no
             ↓                           ↓
Offer new version                 Keep selection unchanged
Hide older picker entries         Show other discovered models unchecked
Keep old chat routes
```

Existing chats, explicit model requests and agent profiles keep their exact
model and account. An automated update adds a new version-specific alias; it
never rebinds an old alias to another model. Older aliases remain routable for
saved chats, but their `pickerHidden` metadata removes them from the normal
picker and marks them unchecked in Choose models. Hidden discovery still
returns them as hidden. Explicitly selecting an older model makes it visible
again and reseeds that provider's watched families and baseline.

The baseline includes models known when the switch was enabled. A model already
visible but deliberately left unchecked is not enabled on the next poll. If an
initial discovery fails, the first successful discovery establishes its baseline
without activating anything. Later failures or empty responses retain the last
working selection; they never downgrade a family or switch to another account.
Adding a connection while this feature is enabled starts from that connection's
chosen models, not every model in its catalog.

Each scope can remember 256 known model IDs. Enabling refuses an oversized
baseline rather than silently dropping choices. If a pending scope first sees
an oversized baseline, it becomes `baselineBlocked` and activates nothing,
even if the catalog later shrinks. Review the selection and turn the setting
off and on to capture a safe baseline again. Catalogs over 4,096 rows are
refused whole rather than truncated.

## Model identity and dates

The supported families are Astra, Sol, Terra, Luna and Daybreak on GPT routes,
and Fable, Opus, Sonnet and Haiku on Claude routes. Copilot's provider-specific
IDs are matched within its own account, not against another provider's models.
Unknown families, previews and ambiguous variants remain off until explicitly
selected. `gpt-5.3-codex` is not silently renamed to Terra.

Numeric versions decide ordering first: 6.10 is newer than 6.9. For two IDs at
the same version, known provider dates can distinguish a newer snapshot only
when both dates are available. Missing dates, equal ranks and unclear IDs do not
authorize a change. A newer date cannot promote an older numeric version.
The gateway never treats first discovery time as a release date.

Model rows show **Provider date** when available. The
[official OpenAI model reference](https://developers.openai.com/api/reference/resources/models/methods/list)
defines `created` as a creation timestamp in Unix seconds, not a release
announcement. Creation and first-seen fields are not treated as release dates
and do not drive activation. Many subscription catalogs expose no release dates,
so version numbers are the reliable fallback. Floating `latest` IDs such as Daybreak stay
under the same ID; the provider can update them without a new alias.

## Scope and availability

Only a provider's authenticated, selectable catalog supplies candidates. A
missing model is not invented, and a missing login is not repaired by copying
credentials from another Mac. M5's pending Copilot login remains a separate
setup step. Grok has no verified model-discovery flow and stays pinned to its
configured models. Unrecognized local model families likewise stay pinned.

A client-only configuration manages its local native fallback preference, not
the remote inference host's providers. An SSH chat uses its execution host's
configuration. Native updates write only the gateway's native picker allowlist;
they never edit native authentication, model cache or the primary Codex config.
New picker reads take the latest valid native presentation settings without
changing any loaded chat's model, permissions or routing. An invalid preference
file leaves the last valid presentation in place.

## Background checks

The existing app-owned gateway service runs metadata maintenance in its process
tree every 300 seconds. It never creates a second LaunchAgent or Login Item.
Inference servers own a hot-swappable timer; a client-only plan without an
inference child runs the timer in its existing supervisor. The settings window
does not need to stay open. A fresh process-identity heartbeat reports whether
the timer is actually active. It does not restart the service or interrupt work.
A slow pass cannot overlap another pass for
the same configuration. A toggle or manual edit during discovery makes the
outdated result stale rather than overwriting the edit.

There is no guaranteed provider model-release webhook. Five minutes is the
poll interval, not a promise of instant visibility; provider propagation, sleep,
authentication and native-cache freshness can delay discovery. The native scope
uses the public cache maintained by the running native engine. Check now runs
the same metadata-only reconciliation; it sends no inference prompt.

```sh
gateway auto-latest check --config /absolute/gateway.json
gateway auto-latest status --config /absolute/gateway.json
```

The app reports when the existing service has not adopted maintenance yet rather
than claiming checks are running. Enabling or disabling the policy changes no
background registration. A verified legacy 0.8.7 model-maintenance LaunchAgent is
removed during migration; foreign jobs are left alone. Output contains fixed
outcomes, counts and timestamps, never
provider credentials, request bodies, tool arguments or raw failure text.

Configuration stores `autoLatestModels.enabled`, each provider's selected
`families` and `baselineModels`, and the separate native scope. Updates use the
existing revision guard, private lock, backup and atomic configuration save.
The alias ledger continues to reserve retired identities. See
[connection management](app-management.md) and [live routing](architecture.md).

## Verification

After `npm run build`, run `npm run app:e2e:auto-latest`. This private fixture
uses a real HTTP gateway with local mock discovery and inference. It verifies
unchanged selections at enable, future family upgrades, unrelated models staying
off, old aliases remaining routable but hidden, native preference isolation, and
disable behavior. It sends no paid inference and changes no installed settings.
