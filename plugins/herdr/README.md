# herdr

Marcus' setup for the [Herdr desktop app](https://herdr.dev), in two halves:

```
Claude Code                                Herdr app (~/.config/herdr-app)
───────────                                ───────────────────────────────
plugin herdr                               mods/tabs-run      top bar, "Artefakte ▾" button
  hooks/bridge.ts ── every Artifact ──┐    mods/artifacts     the dropdown
  (PostToolUse)      publish          │    layouts/main-filetree.json
  skill artifacts-refresh ──┐         │    settings.json, keys.json
                            │         ▼
                            │   ~/.local/state/herdr-artifacts/
                            └──▶  catalog.jsonl    all claude.ai artifacts (snapshot)
                                  artifacts.jsonl  live publishes, with terminal + session
                                        │
                                        └──▶ read by mods/artifacts
```

## The Artefakte dropdown

A button "Artefakte ▾" in the top bar opens a list of your Claude artifacts:

- **Diese Session**: what the Claude session in the focused terminal published.
- **Angepinnt**: your pins (pin icon on hover). On the first import, your claude.ai pins are copied in.
- **Zuletzt**: the 20 newest.
- **Search**: type to search titles and project folders across all artifacts.

↑/↓ selects, Enter opens, Esc closes. Opening means your default browser.

New publishes show up live through the hook. Older claude.ai artifacts come from a snapshot
that only Claude can make (the `Artifact` tool lists them). Tell Claude
**"Artefakte aktualisieren"** whenever you want it refreshed.

## Install

```sh
claude plugin marketplace add cosmic-code-gmbh/cosmic-code-marketplace
claude plugin install herdr@cosmic-code-marketplace
```

Then copy the Herdr half into the app, from a clone of this repo or from the installed plugin:

```sh
sh ~/.claude/plugins/cache/cosmic-code-marketplace/herdr/*/install.sh
```

`install.sh` copies the mods, the layout, `settings.json` and `keys.json`. Any file you
changed is moved to `~/.config/herdr-app/backup-<time>/` first. The layout also uses `filetree`,
`file-icons`, `run-scripts` and `session-bar` from
[cybertron288/herdr-mods](https://github.com/cybertron288/herdr-mods). When they are missing,
the script installs them from there, including the session-bar Claude Code plugin.

In Herdr, switch to the layout **main-filetree** (cmd-shift-l). Restart your Claude Code sessions so the hook loads.

Needs `bun` for the hook and `python3` for the refresh.

## Changing it

The files under `herdr/` are copies of `~/.config/herdr-app`. After editing in the app home,
copy them back here, raise the version in `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`, then push.
