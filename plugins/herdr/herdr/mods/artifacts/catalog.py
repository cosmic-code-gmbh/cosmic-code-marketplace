#!/usr/bin/env python3
"""Writes ~/.local/state/herdr-artifacts/catalog.jsonl for the artifacts dropdown.

Input: a TSV made by Claude from `Artifact list` (scope mine, limit 200, every page), in list
order (most recently opened/updated first), one artifact per line:
    <artifact id>\t<updated YYYY-MM-DD>\t<"p" if pinned on claude.ai, else empty>\t<title>
Folder, file and session come from the Claude Code transcripts where the artifact was published.

    python3 catalog.py artifacts.tsv
"""
import datetime
import glob
import json
import os
import sys

home = os.path.expanduser("~")

local = {}
for f in glob.glob(home + "/.claude/projects/*/*.jsonl"):
    for line in open(f, errors="ignore"):
        if "toolUseResult" not in line or "/artifact/" not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        r = d.get("toolUseResult")
        if isinstance(r, dict) and isinstance(r.get("url"), str) and r.get("path"):
            local[r["url"]] = {"cwd": d.get("cwd"), "path": r["path"], "session": d.get("sessionId")}

rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
out, n = [], len(rows)
for i, (aid, date, pin, title) in enumerate(rows):
    url = "https://claude.ai/artifact/" + aid
    # Noon of the update day; list order breaks ties within a day.
    at = int(datetime.datetime.fromisoformat(date + "T12:00:00").timestamp() * 1000) + (n - i) * 1000
    e = {"at": at, "url": url, "title": title, "source": "claude.ai", "pinned": pin == "p", "terminal": None}
    e.update(local.get(url, {"cwd": None, "path": None, "session": None}))
    out.append(json.dumps(e, ensure_ascii=False))

dst = home + "/.local/state/herdr-artifacts/catalog.jsonl"
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst + ".tmp", "w") as fh:
    fh.write("\n".join(out) + "\n")
os.replace(dst + ".tmp", dst)
print(f"{len(out)} Artefakte, {sum(e != None for e in [local.get('https://claude.ai/artifact/' + r[0]) for r in rows])} mit lokalen Details -> {dst}")
