This is a pi-durable extension, not a Pi coding-agent extension.

It persists channel bindings and send tasks; changes can affect stored conversations and repeat external messages.

## Checks

Run commands from the repository root. Build before workspace typechecking: examples consume the package's generated declarations.

## Invariants

- Acknowledge inbound messages only after durable admission. Outbound sends are at least once; preserve their idempotency keys across retries and recovery.
- Treat document, entry, task, and extension names as persisted identifiers when changing storage or restart behavior.
- Do not add Pi coding-agent discovery metadata or installation instructions.

## Documentation and releases

- When changing domain terms, read `CONTEXT.md` before naming them.
- When changing delivery, tools, or adapter behavior, read and update `packages/channels/README.md`. Update the root `README.md` when example workflows or development setup change.
- When writing adapters, read `skills/writing-channel-adapters/SKILL.md` for transport security and acknowledgement requirements.
- Add release notes with `pnpm changeset`; let the release PR update package versions and changelogs. Public packages under `packages/*` are discovered automatically. The workflow stages on npm; promotion is manual.
- Active plans belong in `.agents/plans/`; useful completed snapshots may go in `.agents/plans/archive/`. Current behavior belongs in the package README, not plans.
