// Helpers an agent runs that Herdr doesn't see as terminals, by the terminal they
// belong to (its HC_TERMINAL_ID): Codex runs started from Claude's Bash tool (a
// sol loop, say) and Claude Code subagents (the herdr plugin's hooks/subagents.ts
// keeps one JSON file per running subagent in SUBAGENTS).
// Each item: { id, name, kind: "codex" | "claude", since (ms) }.

import { exec, home, readTextFile } from "herdr";
import * as fs from "fs/promises";

export const subagentDir = () => `${home()}/.local/state/herdr-subagents`;

// A subagent whose Stop never came (Claude killed) stops counting after this.
const STALE = 6 * 3600000;

// ps's elapsed time, "[[dd-]hh:]mm:ss", in ms.
/** @param {string} s */
function elapsed(s) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((Number(d) * 24 + parts[0]) * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

// Running `codex exec` processes with the terminal they were started from.
// The outermost codex of a chain counts once; a codex without HC_TERMINAL_ID
// (the Codex app, a shell outside Herdr) is left out.
/** @param {number} now */
export async function codexRuns(now) {
  const found = await exec("pgrep", ["-x", "codex"]);
  const pids = found.stdout.split("\n").filter(Boolean);
  if (!pids.length) return [];
  const r = await exec("ps", ["-E", "-ww", "-o", "pid=,ppid=,etime=,command=", "-p", pids.join(",")]);
  const procs = r.stdout.split("\n").filter(Boolean).map((line) => {
    const [, pid, ppid, etime, command] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) ?? [];
    return { pid, ppid, etime, command: command ?? "" };
  }).filter((p) => p.pid && / exec( |$)/.test(p.command));
  const mine = new Set(procs.map((p) => p.pid));
  const runs = procs.filter((p) => !mine.has(p.ppid));
  if (!runs.length) return [];
  // The parent says what it is for: scripts/sol is a Sol review.
  const parents = await exec("ps", ["-ww", "-o", "pid=,command=", "-p", runs.map((p) => p.ppid).join(",")]);
  const parentOf = Object.fromEntries(parents.stdout.split("\n").filter(Boolean).map((l) => {
    const [, pid, cmd] = /^\s*(\d+)\s+(.*)$/.exec(l) ?? [];
    return [pid, cmd ?? ""];
  }));
  return runs.flatMap((p) => {
    const terminal = /\bHC_TERMINAL_ID=(\S+)/.exec(p.command)?.[1];
    if (!terminal) return [];
    const sol = /\/sol(\s|$)/.test(parentOf[p.ppid] ?? "");
    const resume = / exec resume /.test(p.command);
    const name = `${sol ? "Sol" : "Codex"}${resume ? " · Folgerunde" : ""}`;
    return [{ terminal, id: `codex-${p.pid}`, name, kind: "codex", since: now - elapsed(p.etime) }];
  });
}

// Running Claude Code subagents, from the hook's files.
/** @param {number} now */
export async function claudeSubagents(now) {
  let names;
  try { names = await fs.readdir(subagentDir()); } catch { return []; }
  const out = [];
  for (const n of names.filter((n) => n.endsWith(".json") && !n.startsWith("pending-"))) {
    try {
      const s = JSON.parse(await readTextFile(`${subagentDir()}/${n}`));
      if (!s.terminal || now - s.at > STALE) continue;
      out.push({ terminal: s.terminal, id: `sub-${s.id}`, name: s.description || s.type || "Subagent", kind: "claude", since: s.at });
    } catch {}
  }
  return out;
}
