// Each space's git for its header line: repo, branch, ahead/behind. Ported from
// spaces-icons, which no longer shows in the main layout.
// `tick(cx)` on a timer looks only where the answer could have changed: a new place
// (a new space, a cd), where a command or an agent's turn just ended (a checkout, a
// commit), a machine that is back, and, while the window is in front, every place
// whose fallback is due. `of(space, ps)` reads the last answer, null when not a repo.

import { exec, machines, panes, spaces, watchFolder, window } from "herdr";

// Changes made outside Herdr (an editor's save, a commit in another app).
const FALLBACK = 60000;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

export class SpaceGit {
  constructor() {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
  }

  of(s, ps) {
    return this.git[where(s, ps)] ?? null;
  }

  // Which place a space stands for (spacekeep.js): its machine and its repo's top (a worktree
  // has its own top), else the folder its first terminal is in. Null until git has answered
  // for that place, and at home (a scratch space, not a project).
  keyOf(s, ps, home) {
    const k = where(s, ps);
    if (!(k in this.git)) return null;
    const dir = (this.git[k]?.top || place(s, ps) || "").replace(/\/+$/, "");
    if (!dir || dir === home.replace(/\/+$/, "")) return null;
    return JSON.stringify([s.machine ?? null, dir]);
  }

  tick(cx) {
    const due = this.due(Date.now(), spaces(), panes());
    if (due.size) this.refresh(due, cx);
  }

  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    // Moved there: what it knew of that place may be old.
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) if ((this.git[k] || this.unsure.has(k)) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refresh(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pending.size) {
          const batch = [...this.pending];
          this.pending.clear();
          for (const key of batch) await this.check(key, cx);
        }
        const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
        for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      } finally {
        this.refreshing = false;
      }
      cx.notify();
    });
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks and no fsmonitor: nothing written under .git wakes the watch again.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), top: top.stdout.trim(), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refresh(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }
}

// The header's second line: only what's unusual. The repo goes when the name already
// says it, the branch when the name says it or it's main/master. Empty: no line.
export function gitLine(g, name) {
  if (!g) return null;
  const same = (a) => a.toLowerCase() === name.toLowerCase();
  const raw = g.branch ?? "detached";
  const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
  const repo = same(g.name) ? "" : g.name;
  const text = [repo, branch].filter(Boolean).join(" · ");
  return text || g.ahead || g.behind ? { text, ahead: g.ahead, behind: g.behind } : null;
}
