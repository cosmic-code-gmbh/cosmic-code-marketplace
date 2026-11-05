# herdr

Marcus' setup for the [Herdr desktop app](https://herdr.dev), in two halves:

```
Claude Code                                Herdr app (~/.config/herdr-app)
───────────                                ───────────────────────────────
plugin herdr                               mods/tabs-run      top bar: "Artefakte ▾", Fokus button
  hooks/bridge.ts ── every Artifact ──┐    mods/artifacts     the dropdown
  (PostToolUse)      publish          │    mods/fokus         the Fokus sidebar (see below)
                                      │    layouts/main-filetree.json
  skill artifacts-refresh ──┐         │    settings.json, keys.json
                            │         ▼
                            │   ~/.local/state/herdr-artifacts/
                            └──▶  catalog.jsonl    all claude.ai artifacts (snapshot)
                                  artifacts.jsonl  live publishes, with terminal + session
                                        │
                                        └──▶ read by mods/artifacts
```

## The Fokus sidebar

The **Fokus** button in the top bar opens the right panel's third tab, next to Files and Changes.
It shows the [Fokusboard](../fokusboard) of the Claude Code session in the focused terminal, live:
thread, current topic, open questions, todos, artifacts and the decision log. The plan workflow and
your own notes stay in the terminal pane.
The badge on the button counts the open questions. It turns red when one blocks the work.

```
fokusboard plugin (Claude Code)                       mods/fokus (Herdr)
  every second, when the board changed ──► ~/.local/state/fokusboard/<terminal>.json ──► draws it
  carries out the click (prompt box,  ◄── ~/.local/state/fokusboard/<terminal>.inbox.jsonl ◄── a click
  ask, explain, note …)
```

- A click on an answer option puts "Zu „…“: option" in the prompt box. You send it yourself.
- Under each question: Antworten (puts "Zu „…“: " in the prompt box), Erklären, Fragen (Claude
  asks it in a dialog) and ✕ (dismiss). "Alle stellen" asks every open question at once.
- In Herdr the Fokusboard opens no terminal pane. `/fokus` and `◎ Fokus` show this tab instead.
- Each terminal tab shows its own session's board, and the badge counts its questions. A session
  that started before fokusboard 0.9.0 writes none until it restarts. When a session ends, its board turns grey.

Needs `fokusboard@cosmic-code-marketplace` 0.9.0 or later.

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
claude plugin install fokusboard@cosmic-code-marketplace
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
