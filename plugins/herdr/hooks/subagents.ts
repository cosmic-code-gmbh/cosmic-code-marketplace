#!/usr/bin/env bun
// Claude Code hooks (hooks/hooks.json) -> Herdr's Agents list (mods/agents-icons).
// Keeps one file per running subagent in ~/.local/state/herdr-subagents/<agent_id>.json,
// with the herdr terminal Claude runs in (HC_TERMINAL_ID); the mod watches the folder.
//   PreToolUse Agent   remembers the call's description (pending-<session>-<time>.json)
//   SubagentStart      claims the oldest pending description of its session, writes the file
//   SubagentStop       removes it
//   SessionEnd         removes the session's files (subagents whose Stop never came)
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";

const DIR = `${process.env.HOME ?? ""}/.local/state/herdr-subagents`;
// A description not claimed within this long belonged to a call that never started.
const PENDING_TTL = 60_000;

type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: { description?: unknown; subagent_type?: unknown };
};

const safe = (s: string) => s.replace(/[^\w.-]/g, "_");

// The oldest unclaimed description of this session. Renaming claims it, so two
// subagents starting at once never get the same one.
function claim(session: string): string | null {
  const prefix = `pending-${safe(session)}-`;
  const now = Date.now();
  for (const name of readdirSync(DIR).filter((n) => n.startsWith(prefix)).sort()) {
    const path = `${DIR}/${name}`;
    const taken = `${path}.taken`;
    try {
      renameSync(path, taken);
    } catch {
      continue; // another hook got it
    }
    const p = JSON.parse(readFileSync(taken, "utf8"));
    rmSync(taken, { force: true });
    if (now - p.at <= PENDING_TTL) return p.description ?? null;
  }
  return null;
}

function main() {
  const input: HookInput = JSON.parse(readFileSync(0, "utf8"));
  const session = input.session_id ?? "unknown";
  mkdirSync(DIR, { recursive: true });

  switch (input.hook_event_name) {
    case "PreToolUse": {
      const description = input.tool_input?.description;
      if (input.tool_name !== "Agent" || typeof description !== "string") return;
      const at = Date.now();
      writeFileSync(`${DIR}/pending-${safe(session)}-${at}-${process.pid}.json`, JSON.stringify({ at, description }));
      return;
    }
    case "SubagentStart": {
      if (!input.agent_id) return;
      writeFileSync(
        `${DIR}/${safe(input.agent_id)}.json`,
        JSON.stringify({
          id: input.agent_id,
          type: input.agent_type ?? null,
          description: claim(session),
          terminal: process.env.HC_TERMINAL_ID || null,
          session,
          at: Date.now(),
        }),
      );
      return;
    }
    case "SubagentStop":
      if (input.agent_id) rmSync(`${DIR}/${safe(input.agent_id)}.json`, { force: true });
      return;
    case "SessionEnd":
      for (const name of readdirSync(DIR)) {
        if (name.startsWith(`pending-${safe(session)}-`)) rmSync(`${DIR}/${name}`, { force: true });
        else if (name.endsWith(".json")) {
          try {
            if (JSON.parse(readFileSync(`${DIR}/${name}`, "utf8")).session === session) rmSync(`${DIR}/${name}`, { force: true });
          } catch {}
        }
      }
      return;
  }
}

try {
  main();
} catch {
  // A hook must never break the session.
}
