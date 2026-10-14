# Harness Gateway

Edi owns this repo. Renamed from Subscription Gateway; keep the compatibility names listed in the README.
Run `docs-list` and read the matching docs before editing.
Use npm. Run `npm run build` and `npm test` before handoff.
Keep provider authentication separate from Responses translation and routing.
The gateway owns translation and transport, not agent orchestration or task policy.
Preserve caller instructions, roles, model choices and permissions; do not invent them.
The client owns tool execution. Inference providers must not execute native tools, with one exception that Edi decided on 2026-10-14: web search. When the caller's own Codex web search setting allows it, Codex 2 (codex-subscription) uses OpenAI's hosted web search as native Codex does, and Claude may run only the Claude CLI's WebSearch tool, which uses Anthropic's server-side web search. Copilot and API providers have no web search. Every other tool is executed by the client. See docs/responses.md#web-search.
Never log tokens, request bodies, tool arguments, or environment values.
Versioning: the patch tops out at 9; after x.y.9 release x.(y+1).0. Use `npm run version:next`.
Keep this project independently implemented. Record licenses for any added dependencies.
