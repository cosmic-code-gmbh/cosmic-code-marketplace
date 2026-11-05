#!/usr/bin/env bun
// Claude Code PostToolUse hook (matcher "Artifact", hooks/hooks.json) -> Herdr artifacts mod.
// Appends one JSON line per published artifact to ~/.local/state/herdr-artifacts/artifacts.jsonl;
// the mod watches that folder. HC_TERMINAL_ID ties the line to the herdr terminal Claude runs in.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const DIR = `${process.env.HOME ?? ""}/.local/state/herdr-artifacts`;
const FILE = `${DIR}/artifacts.jsonl`;
const KEEP = 500;

type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
};

function main() {
  const input: HookInput = JSON.parse(readFileSync(0, "utf8"));
  if (input.tool_name !== "Artifact") return;
  const args = input.tool_input ?? {};
  // Only page publishes: no read/list/open/..., no asset uploads.
  if ((args.action ?? "publish") !== "publish" || args.asset) return;

  const res = (typeof input.tool_response === "object" && input.tool_response) as Record<string, unknown> | false;
  const raw = JSON.stringify(input.tool_response ?? "");
  const url = (res && typeof res.url === "string" ? res.url : raw.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/)?.[0]) ?? null;
  if (!url) return; // refused or failed publish

  const path = (res && typeof res.path === "string" ? res.path : null) ?? (typeof args.file_path === "string" ? args.file_path : null);
  const title =
    (res && typeof res.title === "string" ? res.title : null) ??
    (typeof args.title === "string" ? args.title : null) ??
    (path ? path.split("/").pop()!.replace(/\.(html|md)$/, "") : url);

  const line = JSON.stringify({
    at: Date.now(),
    terminal: process.env.HC_TERMINAL_ID || null,
    session: input.session_id ?? null,
    cwd: input.cwd ?? null,
    url,
    title,
    path,
  });
  mkdirSync(DIR, { recursive: true });
  appendFileSync(FILE, line + "\n");

  // Keep the file small.
  const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
  if (lines.length > KEEP * 1.2) writeFileSync(FILE, lines.slice(-KEEP).join("\n") + "\n");
}

try {
  main();
} catch {
  // A hook must never break the tool call.
}
