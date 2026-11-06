// Helpers an agent runs that Herdr doesn't see as terminals, by the terminal they
// belong to (its HC_TERMINAL_ID):
// - everything a Claude Code CLI runs through its Bash tool right now: background
//   tasks, Monitor listeners, long commands, and Codex runs among them (a sol loop),
//   found as children of the claude process (cliRuns);
// - Codex runs started anywhere else in a Herdr terminal (also cliRuns);
// - Claude Code subagents, which run inside the claude process: the herdr plugin's
//   hooks/subagents.ts keeps one JSON file per running subagent in subagentDir().
// Each item: { terminal, id, name, kind: "codex" | "claude" | "bash", since (ms) }.

import { exec, home, readTextFile } from "herdr";
import * as fs from "fs/promises";

export const subagentDir = () => `${home()}/.local/state/herdr-subagents`;

// A subagent whose Stop never came (Claude killed) stops counting after this.
const STALE = 6 * 3600000;
// Bash calls younger than this are left out: most end before the next look, and
// showing them would only make rows flicker.
const MIN_AGE = 2000;

// ps's elapsed time, "[[dd-]hh:]mm:ss", in ms.
/** @param {string} s */
function elapsed(s) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((Number(d) * 24 + parts[0]) * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

/** @typedef {{ pid: string, ppid: string, etime: string, command: string }} Proc */

/** @param {string} out @returns {Proc[]} */
function parsePs(out) {
  return out.split("\n").filter(Boolean).map((line) => {
    const [, pid, ppid, etime, command] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) ?? [];
    return { pid, ppid, etime, command: command ?? "" };
  }).filter((p) => p.pid);
}

/** @param {string} command */
const program = (command) => command.split(" ")[0].split("/").pop();
/** @param {{ command: string }} p */
const isClaude = (p) => program(p.command) === "claude";
/** @param {{ command: string }} p */
const isCodexExec = (p) => program(p.command) === "codex" && / exec( |$)/.test(p.command);
// Claude's Bash tool runs each command as `zsh -c source …/shell-snapshots/… && eval '<command>' …`.
/** @param {Proc} p */
const isBashTool = (p) => /\/shell-snapshots\/snapshot-/.test(p.command);

// The command Claude asked for, from its Bash wrapper: first line, without a leading `cd … &&`.
/** @param {string} wrapper */
function bashCommand(wrapper) {
  // Commands with their own stdin (a heredoc) come without the `< /dev/null`.
  const quoted = / eval '([\s\S]*)'(?: < \/dev\/null)? && pwd -P/.exec(wrapper)?.[1];
  if (!quoted) return "Bash";
  const text = quoted.replace(/\\012/g, "\n").replace(/'"'"'/g, "'");
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "Bash";
  const short = line.replace(/^cd\s+\S+\s*&&\s*/, "");
  return short.length > 80 ? `${short.slice(0, 79)}…` : short;
}

// A codex run's name: Sol when scripts/sol started it, a follow-up round when it resumes.
/** @param {Proc} p @param {string | undefined} parentCommand */
function codexName(p, parentCommand) {
  const sol = /\/sol(\s|$)/.test(parentCommand ?? "");
  return `${sol ? "Sol" : "Codex"}${/ exec resume /.test(p.command) ? " · Folgerunde" : ""}`;
}

// Bash-tool runs of every claude process in a Herdr terminal (a Codex run among them
// named as one), and the outermost `codex exec` of chains outside any claude.
/** @param {number} now */
export async function cliRuns(now) {
  const r = await exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,etime=,command="]);
  const procs = parsePs(r.stdout);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  /** @type {Map<string, Proc[]>} */
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid)?.push(p);
  }
  /** @type {(p: Proc) => Proc[]} */
  const below = (p) => (kids.get(p.pid) ?? []).flatMap((k) => [k, ...below(k)]);

  const claudes = procs.filter(isClaude);
  const codexes = procs.filter((p) => isCodexExec(p) && !isCodexExec(byPid.get(p.ppid) ?? { command: "" }));
  const asked = [...claudes, ...codexes];
  if (!asked.length) return [];
  // Which terminal each one runs in: only the HC_TERMINAL_ID of its environment is kept.
  const envs = await exec("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", asked.map((p) => p.pid).join(",")]);
  /** @type {Record<string, string>} */
  const terminalOf = {};
  for (const line of envs.stdout.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(line)?.[1];
    const terminal = /\bHC_TERMINAL_ID=(\S+)/.exec(line)?.[1];
    if (pid && terminal) terminalOf[pid] = terminal;
  }

  const out = [];
  const covered = new Set(); // codex pids already shown under a claude
  for (const c of claudes) {
    const terminal = terminalOf[c.pid];
    if (!terminal) continue;
    for (const shell of (kids.get(c.pid) ?? []).filter(isBashTool)) {
      const age = elapsed(shell.etime);
      const codex = below(shell).find(isCodexExec);
      if (codex) covered.add(codex.pid);
      if (age < MIN_AGE) continue;
      out.push(codex
        ? { terminal, id: `codex-${codex.pid}`, name: codexName(codex, byPid.get(codex.ppid)?.command), kind: "codex", since: now - elapsed(codex.etime) }
        : { terminal, id: `bash-${shell.pid}`, name: bashCommand(shell.command), kind: "bash", since: now - age });
    }
  }
  for (const p of codexes) {
    const terminal = terminalOf[p.pid];
    if (!terminal || covered.has(p.pid)) continue;
    out.push({ terminal, id: `codex-${p.pid}`, name: codexName(p, byPid.get(p.ppid)?.command), kind: "codex", since: now - elapsed(p.etime) });
  }
  return out;
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
