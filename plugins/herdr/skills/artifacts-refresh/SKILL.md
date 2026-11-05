---
name: artifacts-refresh
description: Refresh the Herdr Artefakte dropdown with every claude.ai artifact. Use when the user says "Artefakte aktualisieren", "refresh artifacts", or asks why an artifact is missing from the dropdown.
---

# Artefakte aktualisieren

The dropdown reads two files in `~/.local/state/herdr-artifacts/`:
- `artifacts.jsonl`: written live by this plugin's PostToolUse hook for every publish.
- `catalog.jsonl`: a snapshot of all claude.ai artifacts. Only you can refresh it, because only the `Artifact` tool can list them.

To refresh:

1. Call `Artifact` with `action: "list"`, `scope: "mine"`, `limit: 200`. Follow `next_page_token` until there are no more pages.
2. Write a TSV into the scratchpad, in list order, one artifact per line:
   `<artifact id>\t<updated YYYY-MM-DD>\t<"p" if pinned, else empty>\t<title>`
   The id is the last segment of `https://claude.ai/artifact/<id>`.
3. Run `python3 ~/.config/herdr-app/mods/artifacts/catalog.py <tsv>`. It fills in folder, file and session from the Claude Code transcripts and writes the file atomically.
4. Report the line it prints (count, how many have local details).

The dropdown watches the folder, so no Herdr restart is needed. claude.ai pins are copied into the dropdown's pins only on the first import (`shared` key `artifacts.pinsSeeded`). Later pins are the user's own, so do not reset them.
