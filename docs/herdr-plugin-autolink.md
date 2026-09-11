# Automatic Herdr plugin registration

The extension bundles the `pi-herdr-subagents` Herdr plugin and registers it automatically when an eligible interactive session starts. Users need herdr 0.8.2 or later; no manual plugin setup is required for the normal interactive workflow.

## Session-start behavior

Automatic registration requires all of these conditions:

- Pi is running inside herdr.
- The session uses `tui` mode.
- The process is not a subagent (`PI_SUBAGENT_ID` is unset).
- Another extension has not won registration of the `subagent` tool.
- The herdr server is reachable and meets the minimum version.

Registration depends on the existing plugin entry:

| Registry state | Action |
|---|---|
| Missing | Run `herdr plugin link <package>/herdr-plugin --enabled`, re-read registration, and notify the user. |
| Enabled and linked to this package | Leave the entry untouched. |
| Disabled | Warn with the manual enable command; do not enable it. |
| Enabled and linked to another path | Show both paths and manual recovery commands; do not replace it. |

RPC, JSON, print, and child sessions do not register plugins automatically. Setup failures remain actionable errors for spawn and resume.

Concurrent session starts within a process share one in-flight link attempt. The attempt is cleared when it settles. Later session starts recheck registration, retry failed links when the plugin is still missing, and report disabled or conflicting entries.

A link failure produces a warning with the error and a manual command. A successful CLI call is followed by a registry read: the extension reports success only when the readiness check passes. It does not insert delays or fall back to typing commands into a shell.

## Why launch through a plugin

`herdr pane run` types command text and Enter into a pane's interactive shell. Shell initialization, including `direnv` or `devenv`, can consume that input before the shell is ready. See [the project brief](PROJECT-BRIEF.md) for the launch-race reproduction.

The plugin launch path starts a declared command directly:

```text
herdr plugin pane open --plugin pi-herdr-subagents --entrypoint subagent \
  --placement split --target-pane <pane> --direction right --cwd <cwd> \
  --env PI_HERDR_LAUNCH_SCRIPT=<generated script> --no-focus
```

The manifest declares a dispatcher that executes the generated launch script. This avoids dependence on interactive shell readiness. The plugin must be registered for herdr to resolve its ID.

Registration happens at session startup, where the extension can check the live herdr environment and Pi run mode. It does not depend on an npm installation script.

## Registry ownership and recovery

The plugin directory is resolved relative to the loaded extension, not the working directory. The readiness classifier compares the registered `plugin_root` (or the directory of `manifest_path`) with the bundled directory. Paths are canonicalized so symlinks and macOS `/tmp` aliases compare equally.

`herdr plugin link` replaces an existing entry with the same plugin ID. Automatic registration therefore runs only when the entry is missing. To deliberately switch to another checkout, run:

```bash
herdr plugin link /path/to/pi-herdr-subagents/herdr-plugin --enabled
```

To enable an existing disabled plugin:

```bash
herdr plugin enable pi-herdr-subagents
```

Registration persists in the user's herdr configuration after the Pi package or checkout is removed. When uninstalling the extension, remove the entry with:

```bash
herdr plugin unlink pi-herdr-subagents
```

Unlinking does not opt out of automatic registration: an eligible session will register a missing plugin again. Disable the plugin to keep it registered but inactive.

Temporary installs such as `pi -e` follow the same eligibility rules. If a temporary install registers the plugin, removing that install can leave a stale registry path. Different checkouts report a conflict rather than replacing the entry automatically.

## Implementation

- [`index.ts`](../index.ts): `classifyHerdrSetup` reads readiness without mutating the registry. `linkBundledPluginAndNotify` handles missing-plugin registration and reports the outcome. `attemptBundledPluginLink` shares in-flight work.
- [`src/herdr/client.ts`](../src/herdr/client.ts): `pluginGet` reads registration; `pluginLink` invokes the CLI through the shared execution and error-handling path.
- [`herdr-plugin/herdr-plugin.toml`](../herdr-plugin/herdr-plugin.toml) and [`dispatch.sh`](../herdr-plugin/dispatch.sh): declare and dispatch the pane entrypoint.

Spawn and resume await `ensureHerdrCapability`, including any in-flight registration. Successful readiness results are cached. Session starts and registration attempts invalidate the cache; non-ready results and read errors encountered by `ensureHerdrCapability` clear it so subsequent tool calls can detect repairs.

## Tests and limits

[`test/index.test.ts`](../test/index.test.ts) covers registration eligibility, success notifications, disabled and conflicting entries, symlink equivalence, concurrent starts, subsequent-session rechecks, retry after link or registry-read failures, and spawn after registration. [`test/herdr-client.test.ts`](../test/herdr-client.test.ts) covers CLI arguments and error propagation.

The unit tests use a fake registry. The [integration harness](../test/integration/harness.ts) links the plugin in isolated configuration before server startup. Automatic registration against an already-running herdr server is not covered by these tests. Re-reading registration confirms registry state, not successful pane creation.

See [README setup](../README.md#setup) for installation and troubleshooting commands.
