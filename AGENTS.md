# Harness Gateway

Edi owns this repo. Renamed from Subscription Gateway; keep the compatibility names listed in the README.
Run `docs-list` and read the matching docs before editing.
Use npm. Run `npm run build` and `npm test` before handoff.
Keep provider authentication separate from Responses translation and routing.
The gateway owns translation and transport, not agent orchestration or task policy.
Preserve caller instructions, roles, model choices and permissions; do not invent them.
The client owns tool execution. Inference providers must not execute native tools.
Never log tokens, request bodies, tool arguments, or environment values.
Versioning: the patch tops out at 9; after x.y.9 release x.(y+1).0. Use `npm run version:next`.
Keep this project independently implemented. Record licenses for any added dependencies.
