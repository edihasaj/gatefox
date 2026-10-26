# Harness Gateway

Edi owns this repo. Renamed from Subscription Gateway; keep the compatibility names listed in the README.
Run `docs-list` and read the matching docs before editing.
Use npm. Run `npm run build` and `npm test` before handoff.
For managed desktop deployments, deployment is complete only when `gateway rollout --verify --json` reports `ready` on every target machine. Installation and HTTP health alone are insufficient. Report pending machines and their blockers explicitly; do not force-restart active work without authorization.
Keep exactly one macOS gateway background job, owned by the signed Harness Gateway.app with its icon. This includes Claude Desktop adapters, private inference and SSH forwards, even when their labels say `claude-*` instead of `gateway`. Run recurring model discovery, updates and maintenance inside that existing service tree; never add separate maintenance LaunchAgents, Login Items or cron jobs. Never reset global macOS background-task or privacy databases to hide historical rows. See `docs/macos-background-item.md` and `docs/services.md`.
Clean verified, owned updater download/extraction staging after successful transaction finalization. Preserve pending work, rollback bundles and in-use releases; never accumulate successful-update staging. See `docs/macos-updates.md`.
Keep provider authentication separate from Responses translation and routing.
The gateway owns translation and transport, not agent orchestration or task policy.
Preserve caller instructions, roles, model choices and permissions; do not invent them.
The client owns tool execution. Inference providers must not execute native tools.
Never log tokens, request bodies, tool arguments, or environment values.
Versioning: minor and patch top out at 9; after x.y.9 increment the minor, and after x.9.9 release (x+1).0.0. Use `npm run version:next`.
Keep this project independently implemented. Record licenses for any added dependencies.
