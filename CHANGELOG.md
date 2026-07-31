# Changelog

## Unreleased

### Changed

- **Recursion guard**: subagents can no longer create subagents. The `subagent` and
  `subagent_resume` tools reject calls made from inside a subagent (detected via the
  `PI_SUBAGENT_ID` env var that every launch script exports) with a `recursive spawn blocked`
  error. Subagents are now strictly one level deep — only the top-level session can spawn or
  resume.
- Removed the child-side "keep nested orchestrator alive" auto-exit machinery
  (`src/runtime-state.ts` and the active-subagent count) — it only existed so a subagent
  could stay alive while its own nested children ran, which the recursion guard makes
  impossible.

## v0.2.0

Breaking changes vs upstream `modem-dev/pi-herdr-subagents` @ `c833a55`:

- **herdr ≥ 0.7.5 required** — subagent panes launch via `pane split` + `pane run` instead of `agent start`.
- **`auto-exit` frontmatter removed** — use `interactive: false` for autonomous workers (default) or `interactive: true` for long-running panes.
- **`standalone` session mode removed** — default is `lineage-only`; legacy `session-mode: standalone` maps to `lineage-only`.
- **Default spawn is non-interactive** (`interactive: false`) — autonomous children auto-exit via `PI_SUBAGENT_AUTO_EXIT`.
- **Peer packages** are `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` (not `@mariozechner/*` or `@sinclair/typebox`).

### Added

- `createHerdrSubagentsExtension(opts)` factory with `expandLaunchParams`, `extraSpawnParams`, `providerEntryPaths`, and `spawnDescriptionSuffix` hooks for wrapper packages (e.g. pi-amplike).
- Serialized pane layout (`src/pane-layout.ts`) — first subagent splits right, later stack down.
- Post-spawn BSP layout equalization (`src/herdr/layout-equalize.ts`).
- `/done` command and Ctrl+Shift+J widget toggle for interactive subagents.
- Token breakdown in context-usage sidecar and steer messages.
- `thinking` spawn param and `PI_SUBAGENT_AUTO_EXIT` env for autonomous children.

### Changed

- Subagent tool guidance now mandates ending the parent's turn after spawning/resuming (only spawning more subagents remains allowed before ending it) and notes that results arrive one ping per subagent — the task is complete only once all spawned subagents have reported.
- Auto-close herdr pane on `subagent_done` / `caller_ping` completion.
- `completed-user-exit` renders as normal completion (session closed by user).
- Child sessions always seeded (no null `seedSession`).
