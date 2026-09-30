# Implementation notes: explicit subagent model selection

## Decisions
- **Use the active model scope when present; otherwise use authenticated registry models** — keeps explicit scope boundaries authoritative while using `ModelRegistry.getAvailable()` for the fallback catalog.
- **Treat the current provider as a soft preference** — list it first and refresh guidance before each agent run, without excluding other allowed providers.

- **Keep compatibility with the installed Pi declarations** — use prompt guidelines when structured sections are unavailable, and read optional token usage through structural types. Stateless message renderers implement `Component.invalidate()` without caching.
- **Add a repeatable typecheck command** — `npm run typecheck` checks extension sources and the unit-test suite with strict TypeScript settings.

- **Apply task-complexity guidance to exact parent model IDs** — Sol 6.1 prefers Luna 6 for well-scoped everyday work; Opus 5.5 prefers Sonnet 5.5. Complex or uncertain work stays on the parent or uses the parent model. User requests override this guidance, but scope validation is unchanged.

## Deviations
- **Read `ctx.scopedModels` structurally** — the installed pi extension declarations do not yet expose this property, so the integration reads it through a local context type while retaining the supported `getAvailable()` fallback.
