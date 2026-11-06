# herdr

Marcus' setup for the [Herdr desktop app](https://herdr.dev), in two halves:

```
Claude Code                                Herdr app (~/.config/herdr-app)
───────────                                ───────────────────────────────
plugin herdr                               mods/tabs-run      top bar: tabs fold, sound mute, "Artefakte ▾", Fokus
  hooks/bridge.ts ── every Artifact ──┐    mods/artifacts     the dropdown
  (PostToolUse)      publish          │    mods/fokus         the Fokus sidebar (see below)
                                      │    mods/agents-icons  sidebar: space headers, agents, terminals,
                                      │                       helpers, shelves
                                      │    mods/spaces-icons  the Icon & color… popup
                                      │    mods/menu-icons    right-click menus (space, agent, terminal)
                                      │    mods/session-bar-icons  bottom bar: Claude left, git right
                                      │    mods/workspace-chrome-icons  sidebar footer without its line
                                      │    layouts/main-filetree.json
  skill artifacts-refresh ──┐         │    settings.json, keys.json
                            │         │    themes/*.json      41 Rex color themes
                            │         ▼
                            │   ~/.local/state/herdr-artifacts/
                            └──▶  catalog.jsonl    all claude.ai artifacts (snapshot)
                                  artifacts.jsonl  live publishes, with terminal + session
                                        │
                                        └──▶ read by mods/artifacts
```

## Themes

`herdr/themes/` holds the 41 color themes of the Rex terminal (27 dark, 14 light), converted
to Herdr's theme format. Pick one in Settings → Theme. Rex draws selections inverted; Herdr has
one selection color, so each theme's selection is its background mixed 30 % toward the
foreground.

## Bottom bar

`mods/session-bar-icons` is a copy of `session-bar` from
[cybertron288/herdr-mods](https://github.com/cybertron288/herdr-mods): the Claude chips (model,
effort, ctx / 5h / 7d) sit on the left with the Claude Code robot as icon, folder, branch and git
chips on the right. The meters still come from session-bar's Claude Code plugin, so
`install.sh` keeps installing `session-bar` too.

## Tabs fold away

The sidebar already lists every agent and terminal, so the top bar starts with its tabs folded
behind a button at the left end: `» 6` (6 tabs, a red dot when one has open questions). Click
it to show the tabs, click `«` to fold them again. The choice is remembered.

## No separator lines

The layout has no divider between sidebar and work area, and the tab bar, the bottom bar, the
sidebar footer (`workspace-chrome-icons`, a clone of Herdr's `workspace-chrome`) and the Fokus
panel footer draw no border lines.

## Sound mute

The speaker button left of "Artefakte" creates or removes `~/.claude/sounds/wc3/.muted`.
A sound hook that checks this file before playing (here `~/.claude/hooks/wc3-sound.sh`, not part
of this plugin) stays silent while it exists; a red crossed-out speaker shows it is on.

## Space icons

Each space has an avatar: its own picture, else a duotone icon or its first letter, white on
the space's color. Right-click the space → **Icon & color…** opens a popup with 12 colors,
16 duotone coding icons (terminal, braces, branch, rocket, database, …) and **Choose image…**
(an image or a `.app`); dropping an image or `.app` on the space header works too. A picture
wins over an icon; picking an icon removes the picture. A new space gets the palette color used
least.

```
shared space.colors  { spaceId: "ansi6" | "#hex" }      mods/spaces-icons (popup), agents-icons
shared space.glyphs  { spaceId: "duo-rocket" }          glyphs/duo-*.svg: outline + 35 % fill,
shared space.icons   { spaceId: "space-icons/x.png" }     both currentColor
```

Pictures are stored as 128 px PNGs in `~/.config/herdr-app/space-icons/`. The Agents list shows
the same avatar next to the agent's icon where no space header names the space. The three mods are clones of Herdr's `spaces`, `agents` and `menu` (Herdr replaces
shipped mods on start). The layout shows only agents-icons in the sidebar: the space headers
there replace the Spaces list, so "Choose image…" in the popup is carried out by agents-icons
(`agents-icons.icon:<id>`; commands reach shown mods only).

## Helpers under each agent

The Agents list shows what a Claude agent runs that Herdr doesn't see as a terminal, as
sub-rows with a spinner and the running time:

```
Claude terminal (HC_TERMINAL_ID=t20)
 ├─ Bash tool: background task,       mods/agents-icons/hidden.js: every 3 s, ps -A for the
 │  Monitor listener, long command    claude process's Bash children (≥ 2 s old), ps -E only
 ├─ Bash → scripts/sol → codex exec   for the HC_TERMINAL_ID of claude/codex processes
 └─ Agent tool → subagent             hooks/subagents.ts: one file per running subagent in
                                      ~/.local/state/herdr-subagents/ (watched, and read
                                      every 3 s for changes the watch missed)
```

A Bash row shows the command itself (first line, without a leading `cd … &&`). Codex runs
started by `scripts/sol` read "Sol". The process rows need no hook and work in sessions that
were already running. Subagents (Agent tool, `/simplify`, workflows)
carry the Agent call's description when there is one, else their type. Restart Claude Code
sessions after installing so the hooks load.

## Follow up and Archive

Two shelves in the Agents list that only you fill. Hover a row: list icon = Follow up,
box icon = Archive, pin = Pin. The same button on a shelved row puts it back.

```
Follow up   work is left for you (test, a manual step)    shared agents.followUp
Done · Working · Idle · Needs you   as before
Archive     out of sight, folded; shows a spinner or !    shared agents.archive
            when an archived agent works or needs you
```

An agent sits on one shelf at most, and a shelf wins over a pin. Addresses whose terminal
ended drop off. Section names are small uppercase labels in their state's color.

**Sort "Space, then status"** (third entry in the sort menu, next to Priority and Grouped by
space) is also the space switcher: every space is a card, other machines' spaces first while
they are connected, then Pinned, then this computer's spaces.

```
▣ vps ●  +                       a connected machine, + = new space there
┌──────────────────────────┐
│ ▣ general      [+] [⌄]   │     header in the space's color: solid when selected,
│   published · dev        │     else fading out; second line = repo · branch ↑↓ (spacegit.js)
└──────────────────────────┘
  ┃ TERMINALS                     panes without an agent, click = focus
  ┃ FOLLOW UP · NEEDS YOU · DONE · WORKING · IDLE
  ┃ ARCHIVE 6 ›                   per space here, starts folded
  ┗ a 2 px thread in the space's color
```

- Click the header: select the space. Chevron: fold it (remembered). Folded, it shows no counts,
  only one mark for its most urgent agent that is waiting, done or working.
- "+" on hover: Terminal or an installed agent, started in that space. A new tab in a folded
  space unfolds it.
- Right-click: the space menu. Drag: reorder. Drop an image or `.app`: its picture.
- The narrow rail lists the spaces' pictures on top.

**Right-click menus** (mods/menu-icons): an agent row has Rename, Pin, Follow up, Archive and
Close; a terminal row Rename, Split right, Split down and Close.

Agent names and tab names are cut by their width, not a character count: a wider sidebar
shows more.

## The Fokus sidebar

The **Fokus** button in the top bar opens the right panel's third tab, next to Files and Changes.
It shows the [Fokusboard](../fokusboard) of the Claude Code session in the focused terminal, live:
thread, current topic, open questions, todos, artifacts and the decision log. The plan workflow and
your own notes stay in the terminal pane.
The red badge on the button counts the focused session's open questions.

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

**Question badges:** every Claude tab shows a red badge with the number of open questions on its
board, so you see at a glance where an answer is waiting.

**Tab names:** a tab running Claude Code takes its board's thread title ("Worum es geht"), whole
(the tab bar cuts it by width), and follows it when the thread changes. A tab you named yourself keeps its name;
rename it to "" to hand it back. Before the board has a thread, the tab shows Claude's own
terminal title, as the Agents list does. The board folder is watched and also read every 5 s,
so a change the watch missed, or a tab Herdr recognised late, still gets its name.

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

`install.sh` copies the mods, the layout, `settings.json`, `keys.json` and the themes. Any file you
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
