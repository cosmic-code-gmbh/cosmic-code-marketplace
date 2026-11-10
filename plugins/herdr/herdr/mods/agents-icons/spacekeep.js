// Spaces as places that stay. Herdr closes a space with its last tab and makes a new one for
// every space.new, so the same folder could show up as several spaces, or vanish with its
// last agent. Here a space is its place (SpaceGit.keyOf: machine + repo top, else folder):
//
//   live spaces ──remember()──▶ shared "spaces.kept"  { key: {id, name, folder, look…} }
//        │                       shared "spaces.order" [key…] (where each card sat)
//        │
//        ├─ two live spaces, one place ──Merger──▶ the newer one's terminals move into
//        │    the older one (park, show it, keep), and the empty one closes
//        │
//        └─ a kept place without a live space ──dormant()──▶ a quiet row at the bottom;
//             a click opens it again (space.new in its folder) with its name, color and icon
//
// Only this computer's spaces merge; another machine's labels have their own ids.

import { run, shared, setShared, spaces, panes, notify } from "herdr";

const KEPT = "spaces.kept";
const ORDER = "spaces.order";

const kept = () => shared(KEPT) ?? {};

// Takes down what each live space is now and copies a returning place's look onto its new id.
// keys: space id -> key (null: none yet). look: { colors, icons, glyphs } as stored.
// Answers the look maps, changed where a place came back.
export function remember(sp, keys, look) {
  const before = kept();
  const next = { ...before };
  const colors = { ...look.colors }, icons = { ...look.icons }, glyphs = { ...look.glyphs };
  let restyled = false;
  const seen = new Set();
  for (const s of sp) {
    const key = keys.get(s.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const old = before[key];
    // Back under a new id: it gets the look it had (its name came with space.new).
    if (old && old.id !== s.id && !sp.some((x) => x.id === old.id)) {
      if (old.color) colors[s.id] = old.color;
      if (old.icon) icons[s.id] = old.icon;
      if (old.glyph) glyphs[s.id] = old.glyph;
      restyled = true;
    }
    const [machine, folder] = JSON.parse(key);
    next[key] = {
      id: s.id, name: s.name, named: Boolean(s.named), folder, machine,
      color: colors[s.id] ?? old?.color ?? null, icon: icons[s.id] ?? old?.icon ?? null, glyph: glyphs[s.id] ?? old?.glyph ?? null,
    };
  }
  if (restyled) {
    setShared("space.colors", colors);
    setShared("space.icons", icons);
    setShared("space.glyphs", glyphs);
  }
  if (JSON.stringify(next) !== JSON.stringify(before)) setShared(KEPT, next);

  // Live places keep the order Herdr has; a closed one keeps its slot between them (the
  // closed rows at the bottom come in that order).
  const live = [...new Set(sp.map((s) => keys.get(s.id)).filter(Boolean))];
  const liveSet = new Set(live);
  const queue = [...live];
  const order = [];
  for (const k of shared(ORDER) ?? []) {
    if (!next[k] || order.includes(k)) continue;
    if (!liveSet.has(k)) order.push(k);
    else if (queue.length) order.push(queue.shift());
  }
  for (const k of queue) if (!order.includes(k)) order.push(k);
  if (JSON.stringify(order) !== JSON.stringify(shared(ORDER) ?? [])) setShared(ORDER, order);
  return { colors, icons, glyphs };
}

// Kept places with no live space, each with the live place it follows (null: the top).
export function dormant(liveKeys) {
  const all = kept();
  const out = [];
  let anchor = null;
  for (const k of shared(ORDER) ?? []) {
    if (liveKeys.has(k)) { anchor = k; continue; }
    if (all[k]) out.push({ key: k, after: anchor, ...all[k] });
  }
  return out;
}

export function forget(key) {
  const next = { ...kept() };
  delete next[key];
  setShared(KEPT, next);
  setShared(ORDER, (shared(ORDER) ?? []).filter((k) => k !== key));
}

// Forgets every kept place in that folder that has no live space (any machine).
export function forgetFolder(folder) {
  const dir = folder.replace(/\/+$/, "");
  for (const [key, e] of Object.entries(kept())) {
    if (e.folder === dir && !spaces().some((s) => s.id === e.id)) forget(key);
  }
}

// Opens a kept place again: a new space in its folder (with its name if someone gave one),
// and an agent in it when argv is given.
export function reopen(entry, args = {}) {
  run("space.new", {
    folder: entry.folder,
    machine: entry.machine ?? "",
    ...(entry.named ? { name: entry.name } : {}),
    ...(args.argv ? { argv: args.argv, tab: args.name } : {}),
  });
}

const wait = (cx, ms) => new Promise((r) => cx.timer.after(ms, r));

// Spaces on this computer that stand for the same place, merged into one: the one the place
// was kept under, else the one with the most tabs, else the first. A space someone named
// differently stays as it is. Each space is tried once per start.
export class Merger {
  constructor() {
    this.tried = new Set();
    this.busy = false;
  }

  check(sp, keys, cx) {
    if (this.busy) return;
    const byKey = new Map();
    for (const s of sp) {
      const key = keys.get(s.id);
      if (!key || s.machine) continue;
      (byKey.get(key) ?? byKey.set(key, []).get(key)).push(s);
    }
    const known = kept();
    for (const [key, group] of byKey) {
      if (group.length < 2) continue;
      const into = group.find((s) => s.id === known[key]?.id)
        ?? group.reduce((best, s) => (s.tabs.length > best.tabs.length ? s : best));
      const from = group.find((s) => s !== into && !this.tried.has(s.id)
        && (!s.named || s.name.toLowerCase() === into.name.toLowerCase()));
      if (!from) continue;
      this.tried.add(from.id);
      this.busy = true;
      cx.spawn(async (cx) => {
        try { await this.move(from, into, cx); }
        catch (e) { notify({ title: `Couldn't merge ${from.name}`, body: String(e?.message ?? e), level: "error" }); }
        finally { this.busy = false; cx.notify(); }
      });
      return;
    }
  }

  // Herdr has no "move tab to space": the terminals leave their panes (they keep running)
  // and get a pane again with terminal.keep, which makes a new tab in the space shown right
  // then (not the one its labels name). So the target is shown for the move, and afterwards
  // whatever was shown before, unless that was the space that went.
  async move(from, into, cx) {
    const tabIds = new Set(from.tabs.map((t) => t.id));
    const ps = panes().filter((p) => tabIds.has(p.tab));
    // A mod pane can't move; such a space stays.
    if (!ps.length || ps.some((p) => !p.terminal)) return;
    const names = new Map(ps.map((p) => [p.terminal, from.tabs.find((t) => t.id === p.tab)]));
    const shownBefore = spaces().find((s) => s.active)?.id;
    const focus = from.active ? ps.find((p) => p.focused)?.terminal ?? ps[0].terminal : null;
    for (const p of ps) run("terminal.park", { terminal: p.terminal });
    // Parked when their panes are gone (the empty space closes with them).
    for (let i = 0; i < 40 && panes().some((p) => tabIds.has(p.tab)); i++) await wait(cx, 250);
    if (panes().some((p) => tabIds.has(p.tab))) throw new Error("Its terminals didn't leave their panes.");
    run("space.select", { id: into.id });
    for (let i = 0; i < 20 && !spaces().find((s) => s.id === into.id)?.active; i++) await wait(cx, 100);
    if (!spaces().find((s) => s.id === into.id)?.active) throw new Error(`Couldn't show ${into.name}; its terminals run on without a pane.`);
    for (const p of ps) run("terminal.keep", { terminal: p.terminal });
    // Back in a pane: a tab someone named gets its name again.
    const terms = ps.map((p) => p.terminal);
    for (let i = 0; i < 40 && !terms.every((a) => panes().some((p) => p.terminal === a)); i++) await wait(cx, 250);
    for (const p of panes()) {
      const tab = names.get(p.terminal);
      if (tab?.named) run("tab.rename", { id: p.tab, name: tab.name });
    }
    if (focus) run("pane.focus", { terminal: focus });
    else if (shownBefore && shownBefore !== from.id) run("space.select", { id: shownBefore });
  }
}
