---
summary: 'Named gateway subagents for coordination, verification, and local implementation.'
read_when:
  - Setting up mixed-model orchestration
  - Changing gateway agent profiles or executor inheritance
---

# Gateway agent profiles

Choose a gateway model for the parent chat, such as Codex 2 Sol or Astra. Children
inherit its gateway provider and account routing. In the installed Codex build,
agent role files cannot change the parent's provider. A primary ChatGPT chat
therefore cannot acquire a subscription-gateway child through a model name alone.

Configure the roles on each execution machine:

```sh
gateway agents setup \
  --coordinator codex/gpt-6.1-sol \
  --verifier codex/gpt-6-astra \
  --worker qwen/qwen3.8-flash-next
gateway agents status
```

Setup checks all aliases against the offered gateway catalog. It generates three
Codex role files, each with a model and supported High effort. Edit the choices
by repeating setup. These files and the agent policy stay in gateway-owned state.
Native agent defaults and the primary configuration are unchanged.

The worker is also the default model for delegated tasks in gateway chats.
Named coordinator and verifier roles override that default. All roles inherit
the parent's actual permissions; role instructions do not grant full access.
The native concurrency limit remains authoritative, currently 30 on these Macs.

Select Codex 2 Sol as the main model, then ask:

> Coordinate this task. Delegate implementation to worker, then use verifier for
> an independent review and checks. Give each worker explicit file ownership.
> Review their evidence and resolve defects before reporting completion.

Or select Codex 2 Astra for the parent when you want Astra to coordinate. Use the
named coordinator role for a delegated planning task, rather than changing the
main model implicitly. All offered gateway aliases can be selected during setup;
there is no provider or account fallback if a chosen model fails.

New gateway executors discover the generated profiles. Existing chats retain
their executor; start a new gateway chat or close and resume one to load a changed
policy. SDK subagent discovery and real model routing are separate from showing
models in the desktop picker.

The live test on MacBook Pro 2 used Codex 2 Sol as the parent. Its named Qwen
worker read a fixture and wrote the exact result. Its named Astra verifier then
checked both files. The recorded inference aliases included all three requested
models, and the parent reported success only after the children completed.
