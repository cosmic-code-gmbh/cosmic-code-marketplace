// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left. A space with its own icon
// (shared "space.icons", set in spaces-icons) shows that icon instead of its name;
// one without shows its colored letter, as in the Spaces list. Under an agent also
// run what Herdr doesn't know as terminals: its Bash-tool runs (background tasks,
// listeners), Codex runs and Claude subagents (hidden.js). A space's generic icon
// (shared "space.glyphs") stands in for the letter.
// Sorted "Space, then status", this list is also the space switcher (the main layout
// has no Spaces list any more): every space gets a card whose header is drawn in the
// space's color, with a thread of that color down its sections. A click on the header
// selects the space, its chevron folds it (remembered; folded, it moves to the bottom), "+" starts a terminal or an
// agent there, right-click opens the space menu, dragging reorders, and an image or
// .app dropped on it becomes its picture. Its second line is the git state (spacegit.js).
// A space is its place (spacekeep.js): two spaces in one folder merge into one, and a place
// whose space closed keeps a quiet row at the bottom, which opens it again.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, watchFolder, exec, knownAgents, nextCommand, notify, machines, home } from "herdr";
import { cliRuns, claudeSubagents, subagentDir } from "./hidden.js";
import { SpaceGit, gitLine } from "./spacegit.js";
import { setIcon, pickIcon } from "./icons.js";
import { remember, dormant, forget, forgetFolder, reopen, Merger } from "./spacekeep.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// The same avatar colors as spaces-icons: one strong color per hue.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
  // Spaces, and in each its own Needs you / Done / Working / Idle sections.
  { id: "space-status", label: "Space, then status", icon: "folder" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working", 1: "idle" };

// Shelves you move agents onto by hand; nothing moves them on its own.
// Follow up (top): work is left for you (testing, a manual step).
// Archive (bottom, folded): out of sight until you take it back out.
// Each is a shared list of terminal addresses; an agent sits on at most one,
// and addresses whose terminal is gone are dropped (pruneShelves).
// The default UI font has no heavier faces; the system font does, so the bold uppercase labels use it.
const LABEL_FONT = ".SystemUIFont";
const SHELVES = ["agents.followUp", "agents.archive"];
const shelf = (key) => new Set(shared(key) ?? []);
function setShelf(key, address, on) {
  for (const k of SHELVES) {
    const next = shelf(k);
    const want = on && k === key;
    if (next.has(address) === want) continue;
    want ? next.add(address) : next.delete(address);
    setShared(k, [...next]);
  }
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The last agents each machine reported, shared with the shipped new-menu (same key).
const KNOWN = "new-menu.agents";

// A selection background that fades in and out natively instead of switching hard.
// Put it first in a .relative() element; it sits behind the row's content.
const SOFT = { duration: 180, easing: "ease-out" };
// Rows have fixed heights; a folding space body adds them up to know how tall it opens.
const tall = (el, h) => ((el._h = h), el);
// The selected row: its space's color behind it, so it stands out in a long list.
// link: the row sits in a space card, 9 px right of the card's thread; a branch joins the
// thread to the row, as in a file tree.
function glow(id, on, hex, radius, link = false) {
  return h_flex().id(id).absolute().top(0).left(0).size_full().rounded(radius).bg(hex + "38")
    .opacity(on ? 1 : 0).transition("opacity", SOFT)
    .when(link, (el) => el.child(h_flex().absolute().left(-9).top(0).w(9).h_full().items_center()
      .child(div().w_full().h(2).bg(hex))));
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    if (props()?.newMenu) return this.initNewMenu(cx);
    // Ids whose fold state differs from their default (see isFolded). Folded space
    // cards ("sp-<space>") are kept across restarts.
    this.folded = new Set(JSON.parse(localStorage.getItem("spaceFolds") ?? "[]"));
    // space -> its tab count at the last render: a new tab unfolds its space.
    this.tabCounts = null;
    // Space header drag: the space pressed, and the one the pointer is over.
    this.pressed = null;
    this.over = null;
    this.spaceGit = new SpaceGit();
    this.merger = new Merger();
    cx.timer.every(1000, (cx) => this.spaceGit.tick(cx));
    // Commands from popups:
    // "agents-icons.icon:<id>": "Choose image…" in spaces-icons' popup (the popup's own
    //   tasks end when it closes). The pick waits in its own task, so the loop keeps
    //   taking commands, and nothing that fails ends the loop.
    // "agents-icons.shelf:<agents.followUp|agents.archive>:<on|off>:<terminal>": the
    //   agent row's right-click menu (menu-icons).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const shelfCmd = /^shelf:(agents\.followUp|agents\.archive):(on|off):(.+)$/.exec(c);
        if (shelfCmd) { setShelf(shelfCmd[1], shelfCmd[3], shelfCmd[2] === "on"); cx.notify(); continue; }
        // "agents-icons.forget:<folder>": a closed place's card goes (as its "x").
        const forgetCmd = /^forget:(.+)$/.exec(c);
        if (forgetCmd) { forgetFolder(forgetCmd[1]); cx.notify(); continue; }
        const [, id] = /^icon:(.+)$/.exec(c) ?? [];
        try {
          const s = id && spaces().find((x) => x.id === id);
          if (s) cx.spawn(async (cx) => {
            try {
              const file = await pickIcon(id, s.name);
              if (file) await setIcon(id, file);
            } catch (e) { notify({ title: "Space icon", body: String(e?.message ?? e), level: "error" }); }
            cx.notify();
          });
        } catch (e) { notify({ title: "Space icon", body: String(e?.message ?? e), level: "error" }); }
        cx.notify();
      }
    });
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // terminal -> its hidden helpers, shown as sub-rows (see tree()).
    this.hidden = {};
    this.runs = [];
    this.subs = [];
    // Processes have no event to wait for: looked at every 3 s. The subagent files
    // wake the list at once, and the same look every 3 s catches a change that came
    // between reading the folder and watching it again (or a watch that failed).
    cx.timer.every(3000, (cx) => { this.scanRuns(cx); this.scanSubs(cx); });
    this.scanRuns(cx);
    cx.spawn(async (cx) => {
      // fs may write only under the app home; the hook's folder is made by mkdir.
      await exec("mkdir", ["-p", subagentDir()]).catch(() => {});
      for (;;) {
        await this.scanSubs(cx);
        try { await watchFolder(subagentDir()); } catch { await new Promise((r) => cx.timer.after(3000, r)); }
      }
    });
  }

  scanRuns(cx) {
    // One look at a time, normally. A cancelled task never finishes (gpui-kit Task),
    // so its look would block all later ones: after 65 s (cliRuns: two execs of at
    // most 30 s each) a new look starts anyway. Only the newest look may finish:
    // an older one that still comes back neither unblocks nor overwrites it.
    const busy = this.scanningRuns;
    if (busy && Date.now() - busy.at < 65000) return;
    const scan = (this.scanningRuns = { at: Date.now() });
    cx.spawn(async (cx) => {
      const runs = await cliRuns(Date.now()).catch(() => this.runs);
      if (this.scanningRuns !== scan) return;
      this.scanningRuns = null;
      if (this.update("runs", runs)) cx.notify();
    });
  }

  async scanSubs(cx) {
    const subs = await claudeSubagents(Date.now()).catch(() => this.subs);
    if (this.update("subs", subs)) cx.notify();
  }

  // Keeps a new helper list; true when it shows something else than before.
  update(key, list) {
    const ids = (l) => JSON.stringify(l.map((h) => [h.id, h.name]));
    const changed = ids(list) !== ids(this[key]);
    this[key] = list;
    if (changed) this.regroup();
    return changed;
  }

  regroup() {
    this.hidden = {};
    for (const h of [...this.subs, ...this.runs]) (this.hidden[h.terminal] ??= []).push(h);
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  // Drops follow-ups whose terminal ended. Right after a start terminals() is
  // empty, so an empty list prunes nothing.
  pruneShelves(all) {
    if (!all.length) return;
    const known = new Set(all.filter((t) => t.state === "live").map((t) => t.address));
    for (const k of SHELVES) {
      const marked = shelf(k);
      const kept = [...marked].filter((a) => known.has(a));
      if (kept.length !== marked.size) setShared(k, kept);
    }
  }

  // Archives start folded, everything else open; a click flips it.
  isFolded(id) {
    return this.folded.has(id) !== (id === "archive" || id.endsWith(":archive"));
  }

  toggleFold(id) {
    this.setFold(id, !this.folded.has(id));
  }

  // on: the id differs from its default. Space cards ("sp-<id>", not their sections
  // "sp-<id>-3" / "sp-<id>:archive") are written through.
  setFold(id, on) {
    on ? this.folded.add(id) : this.folded.delete(id);
    const card = (f) => /^sp-[^:-]+$/.test(f);
    if (card(id)) localStorage.setItem("spaceFolds", JSON.stringify([...this.folded].filter(card)));
  }

  // Every space has a color (shared "space.colors"): a new one gets the palette color
  // used least, a closed one's entry goes. Taken over from spaces-icons' list, which the
  // main layout no longer shows. Answers the colors.
  assignColors() {
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const stored = shared("space.colors") ?? {};
    const sp = spaces();
    const ids = new Set(sp.map((s) => s.id));
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return kept;
  }

  // A tab that appears in a folded space unfolds it, so what was just started shows.
  unfoldGrown() {
    const counts = Object.fromEntries(spaces().map((s) => [s.id, s.tabs.length]));
    if (this.tabCounts) {
      for (const [id, n] of Object.entries(counts)) {
        if (n > (this.tabCounts[id] ?? n) && this.folded.has(`sp-${id}`)) this.setFold(`sp-${id}`, false);
      }
    }
    this.tabCounts = counts;
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // The "+" popup of a space header: like new-menu (Terminal, then the installed agents),
  // but it starts the tab in that space, not in the one open right now.
  initNewMenu(cx) {
    const machine = props().kept ? props().kept.machine : spaces().find((s) => s.id === props().space)?.machine;
    const where = machine ?? "";
    this.agentsKnown = shared(KNOWN)?.[where] ?? [];
    cx.spawn(async (cx) => {
      try {
        this.agentsKnown = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agentsKnown });
      } catch { this.agentsFailed = true; }
      cx.notify();
    });
  }

  newMenu(t) {
    const space = props().space;
    const start = (args) => {
      closeOverlay(props().overlay);
      // A closed place: open it again, with the agent as its first tab.
      if (props().kept) reopen(props().kept, args);
      else run("tab.new", { space, ...args });
    };
    const item = (id, pic, name, onClick) => h_flex()
      .id(id).h(31).px(8).gap(9).rounded(7).items_center().flex_none()
      .text_color(t.foreground).hover((el) => el.bg(t.hover))
      .on_click(onClick)
      .child(pic).child(div().flex_1().truncate().child(name));
    const installed = this.agentsKnown.filter((a) => a.installed);
    return v_flex().w_full().h(Math.min(420, 76 + Math.max(1, installed.length) * 31)).p(5).bg(t.popover).text_size(12.8)
      .child(item("nm-terminal", svg("icons/shell.svg").size(14).flex_none(), "Terminal", () => start({})))
      .child(div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child(`Start an agent in ${props().spaceName ?? "this space"}`))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(installed.map((a) => item(`nm-${a.key}`,
          a.tint ? svg(a.icon).size(14).flex_none().text_color(t.foreground) : image(a.icon).size(14).flex_none(),
          a.name, () => start({ name: a.name, argv: a.run }))))
        .when(installed.length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim)
          .child(this.agentsFailed ? "Could not load agents" : "Checking installed agents…"))));
  }

  // Every pane that runs no agent (shells, editors, dev servers), by space in space
  // order, each with its tab: space id -> { space, items: [{ p, tab }] }.
  terminalsBySpace() {
    const tabSpace = new Map();
    for (const s of spaces()) for (const tab of s.tabs) tabSpace.set(tab.id, { space: s, tab });
    const bySpace = new Map();
    for (const p of panes()) {
      if (!p.terminal || p.status || p.program?.agent) continue;
      const at = tabSpace.get(p.tab);
      if (!at) continue;
      (bySpace.get(at.space.id) ?? bySpace.set(at.space.id, { space: at.space, items: [] }).get(at.space.id)).items.push({ p, tab: at.tab, space: at.space.id });
    }
    return bySpace;
  }

  // One terminal: its icon, a name, and grey the folder it's in. A click focuses its pane,
  // a right-click opens its menu (menu-icons, "terminal").
  // link: inside a space card (see glow).
  termRow(t, { p, tab, space }, link = false) {
    const live = clean(p.title);
    // A named tab says what it is; else a telling title (not a path or user@host); else the program.
    const telling = live && live !== p.program?.name && !/^[~/]/.test(live) && !live.includes("@");
    const name = tab.named ? tab.name : telling ? live : p.program?.name || "Terminal";
    const where = p.cwd ? p.cwd.split("/").filter(Boolean).at(-1) ?? "/" : "";
    return h_flex().id(`term-${p.pane}`).relative().px(8).h(28).flex_none().gap(9).rounded(8).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .child(glow(`term-sel-${p.pane}`, p.focused, this.spaceHexFor?.(space) ?? t.accent.slice(0, 7), 8, link))
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .on_mouse_down("right", () => openOverlay({ mod: "menu-icons", kind: "popup", width: 200, height: 160, props: { tab: "terminal", target: { pane: p.pane, tab: tab.id } } }))
      // The section's blue on the icon: terminals read apart from the agents' program icons.
      .child(p.program?.tint || !p.program?.icon ? svg(p.program?.icon ?? "icons/shell.svg").size(14).flex_none().text_color(t.ansi4) : icon(p.program, 14))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(p.focused, (el) => el.font_semibold()).child(name))
      .when(Boolean(where) && where !== name, (el) => el.child(div().flex_none().max_w(90).truncate().text_size(11).text_color(t.dim).child(where)));
  }

  // Sorts without space cards (priority, grouped): the terminals as their own section
  // under the agents, per space. Folds: "terms" and "terms-<space>"; both start open.
  terminalRows(t) {
    const bySpace = this.terminalsBySpace();
    if (!bySpace.size) return [];
    const open = !this.isFolded("terms");
    const head = h_flex().id("terms").px(8).pt(20).h(42).flex_none().gap(6).items_center()
      .text_size(10).font_family(LABEL_FONT).font_bold().text_color(t.dim)
      .cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.toggleFold("terms"); cx.notify(); })
      .child(div().child("TERMINALS"))
      .when(!open, (el) => el.child(div().text_color(t.dim).child(String([...bySpace.values()].reduce((n, g) => n + g.items.length, 0)))))
      .child(div().flex_1())
      .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none()));
    if (!open) return [head];
    const pic = this.spacePicFor;
    const out = [head];
    for (const { space, items } of bySpace.values()) {
      const id = `terms-${space.id}`;
      const spOpen = !this.isFolded(id);
      out.push(h_flex().id(id).px(8).pt(6).h(28).flex_none().gap(6).items_center()
        .text_size(11).font_medium().text_color(t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.toggleFold(id); cx.notify(); })
        .child(pic({ space: space.id, space_name: space.name }, 14))
        .child(div().truncate().child(space.name))
        .when(!spOpen, (el) => el.child(div().text_color(t.dim).child(String(items.length))))
        .child(div().flex_1())
        .when(!spOpen, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
      if (spOpen) out.push(...items.map((it) => this.termRow(t, it)));
    }
    return out;
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    // Hidden helpers look like sub-agents that are working; a click shows their agent.
    const hidden = (this.hidden?.[addr] ?? []).map((h) => ({
      address: `${addr}:${h.id}`, name: h.name, status: "working", since: h.since, owner: addr,
      program: h.kind === "bash" ? { icon: "icons/shell.svg", tint: true } : { icon: h.kind === "codex" ? "icons/codex.svg" : "icons/claude.svg" },
    }));
    const kids = [...all.filter((k) => k.parent === addr && k.state === "live"), ...hidden];
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  // Frames the shown panes in the selected space's color: every block of the layout that
  // frames panes (content.pane with border and focus) gets it, faint as its border and full
  // when focused, 2 px wide. Only when the space or its color changed, and only if the layout differs.
  paintPanes(hex) {
    if (!hex || this.painted === hex) return;
    this.painted = hex;
    const tree = layout();
    let changed = false;
    const walk = (n) => {
      const p = n?.content?.pane;
      if (p?.border && p?.focus && (p.border.color !== hex + "59" || p.focus.color !== hex || p.border.width !== 2 || p.focus.width !== 2)) {
        p.border = { ...p.border, width: 2, color: hex + "59" };
        p.focus = { ...p.focus, width: 2, color: hex };
        changed = true;
      }
      (n?.children ?? []).forEach(walk);
    };
    walk(tree);
    if (changed) run("layout.set", { layout: tree });
  }

  // indent: where the tree line starts, under the middle of the parent's program icon.
  // tint: the space's color for the tree lines while the parent row is selected.
  // first: right under the parent row, whose line starts at its edge instead of reaching
  // into it (a selected parent's card would be crossed).
  subRow(t, s, shown, compact, indent, tint = null, first = false) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(indent)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => k.owner ? run("pane.focus", { pane: this.listedPane.get(k.owner) }) : this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(first ? 0 : -4).w(9).h(first ? 13 : 17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(tint ?? t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .when(Boolean(k.since), el => el.child(div().flex_none().mr(6).text_size(11).text_color(t.dim).child(duration(Date.now() - k.since))))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.newMenu) return this.newMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.listedPane = new Map(list.map((a) => [a.address, a.pane]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    this.unfoldGrown();
    const byPriority = sort.id === "priority";
    const bySpaceStatus = sort.id === "space-status";
    // State sections name the state, so rows can say it more quietly.
    const sectioned = byPriority || bySpaceStatus;
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    const urgentFirst = (x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq;
    this.pruneShelves(all);
    const marked = shelf("agents.followUp");
    const shelved = shelf("agents.archive");
    // A shelf wins over a pin: you put the agent there on purpose.
    const onShelf = (a) => marked.has(a.address) || shelved.has(a.address);
    // Follow up, then the rest, then Archive.
    const shelfAt = (a) => (marked.has(a.address) ? 0 : shelved.has(a.address) ? 2 : 1);
    if (byPriority) list = [...list].sort(urgentFirst);
    if (bySpaceStatus) {
      // Spaces keep their order (as in agents()); inside one: Follow up, most urgent first, Archive.
      const spaceAt = new Map();
      for (const a of list) if (!spaceAt.has(a.space)) spaceAt.set(a.space, spaceAt.size);
      list = [...list].sort((x, y) => spaceAt.get(x.space) - spaceAt.get(y.space) || shelfAt(x) - shelfAt(y) || urgentFirst(x, y));
    }
    const later = list.filter((a) => marked.has(a.address));
    const archived = list.filter((a) => shelved.has(a.address));
    const pinned = list.filter((a) => a.pinned && !onShelf(a));
    const rest = list.filter((a) => !a.pinned && !onShelf(a));
    // By space and status, the shelves sit inside each space; elsewhere they're global.
    const spaced = list.filter((a) => onShelf(a) || !a.pinned);
    list = bySpaceStatus ? [...pinned, ...spaced] : [...pinned, ...later, ...rest, ...archived];
    setAgentOrder(list.map((a) => a.address));

    // Rows without a space header above (priority, pinned, global shelves) name their space.
    const showsSpace = (a) => byPriority || (a.pinned && !onShelf(a)) || (!bySpaceStatus && onShelf(a));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = tall(row(a, i, subs), collapsed ? 26 : 30);
      if (this.folded.has(a.address)) return [r];
      // The parent's program icon (16 px) sits at 8 px, or after the space icon when the
      // row shows one: the line starts under its middle.
      const indent = showsSpace(a) ? 40 : 15;
      return [r, ...subs.map((s, j) => tall(this.subRow(t, s, shown, sectioned, indent, a.focused ? spaceHex(a.space) : null, j === 0), 26))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const ps = panes();
    const leads = leadPanes(ps);
    const tabLabels = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    const labels = new Map(list.map(a => [a.address, tabLabels.get(a.tab) ?? (a.title || a.program?.name || "")]));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    // Each space's place; remembered, and a place that came back gets its look again.
    const allSpaces = spaces();
    const placeKeys = new Map(allSpaces.map((s) => [s.id, this.spaceGit.keyOf(s, ps, home())]));
    const look = remember(allSpaces, placeKeys, { colors: this.assignColors(), icons: shared("space.icons") ?? {}, glyphs: shared("space.glyphs") ?? {} });
    this.merger.check(allSpaces, placeKeys, cx);
    const spaceIcons = look.icons;
    const spaceColors = look.colors;
    const spaceGlyphs = look.glyphs;
    // The space's picture, else its generic icon or letter on its color (as spaces-icons draws it).
    // A space's color as #rrggbb (stored as a palette name or as hex).
    const spaceHex = (id) => {
      const c = spaceColors[id] ?? this.dormantLook?.[id]?.color ?? "ansi6";
      return (c.startsWith("#") ? c : (MARK[c] ?? t[c] ?? t.accent)).slice(0, 7);
    };
    const spacePic = (a, size) => {
      const radius = Math.round(size * 0.28);
      const pic = spaceIcons[a.space] ?? this.dormantLook?.[a.space]?.icon;
      if (pic) return image(pic).w(size).h(size).flex_none().rounded(radius);
      // Only our duotone set (duo-*); an earlier icon name falls back to the letter.
      const g = spaceGlyphs[a.space] ?? this.dormantLook?.[a.space]?.glyph ?? "";
      const glyph = /^duo-/.test(g) ? g : null;
      return h_flex().size(size).flex_none().rounded(radius).bg(spaceHex(a.space)).items_center().justify_center()
        .child(glyph
          ? svg(`mods/spaces-icons/glyphs/${glyph}.svg`).size(Math.round(size * 0.8)).text_color("#ffffff")
          : div().text_size(size * 0.58).font_bold().text_color("#ffffff").child([...(a.space_name || "?")][0].toUpperCase()));
    };
    // terminalRows draws the same space pictures.
    this.spacePicFor = spacePic;
    this.spaceHexFor = spaceHex;
    const shownSpace = spaces().find((s) => s.active)?.id;
    if (shownSpace) this.paintPanes(spaceHex(shownSpace));

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      // Idle and archived rows step back.
      const idle = (a.status === "idle" || shelved.has(a.address)) && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      const isLater = marked.has(a.address);
      const isArchived = shelved.has(a.address);
      // A hover button that puts the agent on a shelf or takes it back off.
      const shelfBtn = (key, on, icons, tips) => div()
        .id(`${key}-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(on ? tips[1] : tips[0])
        .on_click((_e, cx) => {
          cx.stop_propagation();
          setShelf(key, a.address, !on);
          this.hovered = null;
          cx.notify();
        })
        .child(svg(on ? icons[1] : icons[0]).size(13));
      const laterBtn = shelfBtn("agents.followUp", isLater,
        ["mods/agents-icons/list-todo.svg", "mods/workspace-chrome/circle-check.svg"], ["Move to Follow up", "Followed up: move back"]);
      const archiveBtn = shelfBtn("agents.archive", isArchived,
        ["mods/workspace-chrome/archive.svg", "mods/agents-icons/archive-restore.svg"], ["Archive", "Take out of Archive"]);
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned, follow up) the row names its space.
      const full = showsSpace(a);
      // Without a space header, the space's icon or letter says which space.
      const sp = full ? spacePic(a, 16) : null;
      const name = more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .relative()
        .child(glow(`ag-sel-${a.address}`, a.focused, spaceHex(a.space), 8, bySpaceStatus && !showsSpace(a)))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        // Its menu (menu-icons, "agent"): rename, pin, Follow up, Archive, close.
        .on_mouse_down("right", () => openOverlay({ mod: "menu-icons", kind: "popup", width: 210, height: 200, props: { tab: "agent", target: { terminal: a.address, pane: a.pane, tab: a.tab } } }))
        .when(Boolean(sp), el => el.child(div().id(`agent-space-${a.address}`).tooltip(a.space_name || "").child(sp)))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).truncate().text_color(idle && !a.focused ? t.muted : t.foreground).when(a.focused, (el) => el.font_semibold()).child(name)))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        // The fold chevron only on hover; folded, it stays (it carries the count).
        .when(subs.length > 0 && (this.hovered === a.address || this.folded.has(a.address)), el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(h_flex().flex_none().gap(2).when(!isArchived, (el) => el.child(laterBtn)).child(archiveBtn).when(!isArchived, (el) => el.child(pin))))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, sectioned && !isPinned && !isLater && !isArchived));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = [];
    if (pinned.length) groups.push({ id: "pinned", label: "Pinned", status: null, members: pinned });
    if (bySpaceStatus) {
      for (const a of spaced) {
        // A space header that only folds, then the space's sections under it.
        const sp = `sp-${a.space}`;
        const space = groups.findLast((g) => g.id === sp);
        if (space) space.members.push(a);
        else groups.push({ id: sp, label: a.space_name || "", status: null, members: [a], headerOnly: true, space: a.space });
        const r = rankOf(a) || RANK.idle;
        const sec = marked.has(a.address) ? { id: `${sp}:followup`, label: "Follow up", status: null, color: t.ansi5 }
          : shelved.has(a.address) ? { id: `${sp}:archive`, label: "Archive", status: null }
          : { id: `${sp}-${r}`, label: SECTION[r], status: SECTION_STATUS[r] };
        if (groups.at(-1)?.id === sec.id) groups.at(-1).members.push(a);
        else groups.push({ ...sec, members: [a], parent: sp });
      }
      // Each space's terminals as the first section in its card, above Follow up.
      // Every space gets a card, in space order: the headers are the space switcher.
      const terms = this.terminalsBySpace();
      for (const s of spaces()) {
        if (!groups.some((g) => g.id === `sp-${s.id}`)) {
          groups.push({ id: `sp-${s.id}`, label: s.name, status: null, members: [], headerOnly: true, space: s.id });
        }
      }
      const order = new Map(spaces().map((s, i) => [`sp-${s.id}`, i]));
      const at = (g) => (g.id === "pinned" ? -1 : order.get(g.parent ?? g.id) ?? Infinity);
      // Stable: within a space, header and sections keep their order.
      const sorted = groups.map((g, i) => [g, i]).sort(([x, i], [y, j]) => at(x) - at(y) || i - j).map(([g]) => g);
      groups.length = 0;
      for (const g of sorted) {
        groups.push(g);
        const items = g.headerOnly && terms.get(g.space)?.items;
        if (items) groups.push({ id: `${g.id}:terms`, label: "Terminals", status: null, color: t.ansi4, members: items, parent: g.id, terms: true });
      }
    }
    if (!bySpaceStatus && later.length) groups.push({ id: "follow-up", label: "Follow up", status: null, color: t.ansi5, members: later });
    for (const a of bySpaceStatus ? [] : rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a], pic: byPriority ? null : spacePic(a, 14), space: byPriority ? null : a.space });
    }
    if (!bySpaceStatus && archived.length) groups.push({ id: "archive", label: "Archive", status: null, members: archived });

    const spaceById = new Map(spaces().map((s) => [s.id, s]));
    // Other machines whose layout is readable: connected. Their spaces lead the list.
    const connected = machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name).sort();
    const machineOf = (id) => spaceById.get(id)?.machine ?? null;
    // A connected machine's label above its spaces, with "+" for a new space there.
    const machineHead = (m, i) => h_flex().id(`machine-${m}`).h(26).mt(i ? 14 : 2).flex_none().px(8).gap(7).items_center()
      .text_size(11).text_color(t.dim)
      .child(svg("mods/workspace-chrome/server.svg").size(13).flex_none())
      .child(div().flex_1().truncate().child(m))
      .child(div().size(6).rounded(3).flex_none().bg(t.ansi2))
      .child(div().id(`machine-new-${m}`).flex_none().size(20).rounded(5).flex().items_center().justify_center()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`New space on ${m}`)
        .on_click(() => run("space.new", { machine: m }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)));
    const activeSpace = spaces().find((s) => s.active)?.id;
    const newIn = (id, name) => openOverlay({ mod: "agents-icons", kind: "popup", width: 250, height: 420, props: { newMenu: true, space: id, spaceName: name } });

    // A space card's header (by space and status): picture, name and git line on the
    // space's color, which fades out to the right. Click selects, drag reorders, the
    // chevron folds; folded, one quiet mark for the most urgent agent inside, no counts.
    const spaceHeader = (g) => {
      const s = spaceById.get(g.space);
      const on = g.space === activeSpace;
      const open = !this.isFolded(g.id);
      const hex = spaceHex(g.space);
      const git = s ? gitLine(this.spaceGit.of(s, ps), g.label) : null;
      const where = [s?.machine, git?.text].filter(Boolean).join(" · ");
      const top = open ? 0 : g.members.filter((a) => !shelved.has(a.address)).reduce((m, a) => Math.max(m, rankOf(a) || 0), 0);
      // The selected space is a solid card in its color. The others fade out to the right:
      // elements take no gradient fill, so in steps, strongest behind the picture. The first
      // step is wider than the corner radius, or the rounding is cut to its width.
      const STEPS = 32, from = 0.34, reach = 0.85;
      const tint = (a) => hex + Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0");
      // Text in the space's color, lifted toward white so it reads on the tinted card.
      const lift = (k) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + 255 * k).toString(16).padStart(2, "0")).join("");
      // Both layers stay; switching space crossfades them.
      const fade = (el, shown) => el.opacity(shown ? 1 : 0).transition("opacity", { duration: 220, easing: "ease-out" });
      const solid = fade(div().id(`solid-${g.id}`).absolute().top(0).left(0).size_full().rounded(11).bg(tint(0.55)), on);
      const band = fade(h_flex().id(`band-${g.id}`).absolute().top(0).left(0).size_full(), !on)
        .child(div().w(22).flex_none().h_full().rounded_l(11).bg(tint(from)))
        .children(Array.from({ length: STEPS }, (_, i) => div().flex_1().h_full()
          .when(i === STEPS - 1, (el) => el.rounded_r(11))
          .bg(tint(from * (1 - (i + 0.5) / STEPS / reach)))));
      const order = spaces().map((x) => x.id);
      const dragging = this.pressed !== null && this.pressed !== g.space;
      const btn = (id, tip, icon, onClick) => div().id(id).flex_none().size(24).rounded(6)
        .flex().items_center().justify_center().text_color(t.muted).cursor_pointer()
        .hover((st) => st.bg(t.foreground + "1f").text_color(t.foreground))
        .tooltip(tip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(svg(icon).size(14));
      return h_flex()
        .id(g.id)
        .relative()
        .h(40)
        .flex_none()
        .pl(7)
        .pr(4)
        .gap(9)
        .items_center()
        .rounded(11)
        .cursor_pointer()
        .when(this.pressed === g.space && this.over !== g.space, (el) => el.opacity(0.5))
        .on_hover((hovered, cx) => {
          if (hovered) this.hoveredHeader = g.id;
          else if (this.hoveredHeader === g.id) this.hoveredHeader = null;
          cx.notify();
        })
        .on_mouse_down("left", () => { this.pressed = g.space; this.over = g.space; })
        .on_mouse_move((_e, cx) => {
          const from = spaceById.get(this.pressed);
          const over = from && (from.machine ?? null) === (s?.machine ?? null) ? g.space : null;
          if (this.pressed !== null && this.over !== over) { this.over = over; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed, over = this.over;
          this.pressed = null;
          this.over = null;
          if (from !== null && over === g.space && from !== g.space) run("space.move", { id: from, index: order.indexOf(g.space) + 1 });
          else if (from === g.space) run("space.select", { id: g.space });
          cx.notify();
        })
        // The same space menu as before (rename, icon & color, worktrees, close).
        .on_mouse_down("right", () => openOverlay({ mod: "menu-icons", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: g.space } } }))
        .on_drop((e, cx) => {
          const file = e.paths?.[0];
          if (file) cx.spawn(async (cx) => {
            try { await setIcon(g.space, file); }
            catch (err) { notify({ title: "Space icon", body: String(err?.message ?? err), level: "error" }); }
            cx.notify();
          });
        })
        .child(band)
        .child(solid)
        .when(dragging && this.over === g.space, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(order.indexOf(this.pressed) < order.indexOf(g.space), (line) => line.bottom(0))
          .when(order.indexOf(this.pressed) > order.indexOf(g.space), (line) => line.top(0))))
        .child(spacePic({ space: g.space, space_name: g.label }, 26))
        // Tight lines: the default line height spreads name and git line apart.
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(14.5).line_height(1.1).font_semibold().text_color(lift(0.78)).child(g.label))
          .when(Boolean(where) || git?.ahead > 0 || git?.behind > 0, (el) => el.child(h_flex().min_w(0).gap(5).items_center().text_size(11).line_height(1.15).text_color(lift(0.4) + "d9")
            .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
            .when(git?.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${git.ahead}`)))
            .when(git?.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${git.behind}`))))))
        .when(top >= RANK.working, (el) => el.child(div().flex_none().mr(2).child(this.status(t, { status: SECTION_STATUS[top] }, true))))
        // "+" and fold only on hover, side by side (the header's gap would part them).
        .when(this.hoveredHeader === g.id, (el) => el.child(h_flex().flex_none().gap(0)
          .child(btn(`new-${g.id}`, `New terminal or agent in ${g.label}`, "mods/workspace-chrome/plus.svg", () => newIn(g.space, g.label)))
          .child(btn(`fold-${g.id}`, open ? "Fold" : "Unfold", `mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`, (cx) => { this.toggleFold(g.id); cx.notify(); }))));
    };

    // Places whose space closed (spacekeep.js), by space and status only, and only on this
    // computer or a connected machine. Their pictures go by "kept:<key>".
    const liveKeys = new Set([...placeKeys.values()].filter(Boolean));
    const asleep = bySpaceStatus ? dormant(liveKeys).filter((d) => !d.machine || connected.includes(d.machine)) : [];
    this.dormantLook = Object.fromEntries(asleep.map((d) => [`kept:${d.key}`, d]));
    // A closed place: a quiet row where its card was. A click opens it again in its folder,
    // "+" opens it with an agent, "x" forgets it.
    const dormantCard = (d) => {
      const id = `kept-${d.machine ?? ""}-${d.folder}`;
      const hovered = this.hoveredHeader === id;
      const btn = (bid, tip, icon, onClick) => div().id(bid).flex_none().size(24).rounded(6)
        .flex().items_center().justify_center().text_color(t.dim).cursor_pointer()
        .hover((st) => st.bg(t.foreground + "1f").text_color(t.foreground))
        .tooltip(tip)
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(svg(icon).size(13));
      return h_flex().id(id).relative().h(34).flex_none().pl(10).pr(4).gap(9).items_center().rounded(11)
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hoveredHeader = id;
          else if (this.hoveredHeader === id) this.hoveredHeader = null;
          cx.notify();
        })
        .on_click(() => reopen(d))
        .child(div().opacity(0.5).child(spacePic({ space: `kept:${d.key}`, space_name: d.name }, 20)))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.dim).child(d.name))
        .when(Boolean(d.machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(d.machine)))
        .when(hovered, (el) => el.child(h_flex().flex_none().gap(0)
          .child(btn(`${id}-new`, `Open ${d.name} with a terminal or agent`, "mods/workspace-chrome/plus.svg",
            () => openOverlay({ mod: "agents-icons", kind: "popup", width: 250, height: 420, props: { newMenu: true, kept: d, spaceName: d.name } })))
          .child(btn(`${id}-forget`, `Remove ${d.name} from the list`, "mods/workspace-chrome/x.svg", (cx) => { forget(d.key); this.hoveredHeader = null; cx.notify(); }))));
    };
    // Puts each closed place after the live card it followed; before the first card when
    // it led, at the end when what it followed isn't shown.
    const withDormant = (list) => {
      if (!asleep.length) return list;
      const res = [];
      const placed = new Set();
      const put = (ds) => { for (const d of ds) if (!placed.has(d.key)) { placed.add(d.key); res.push({ dormant: d }); } };
      let led = false;
      for (const c of list) {
        if (!led && c.card === true) { put(asleep.filter((d) => !d.after)); led = true; }
        res.push(c);
        const k = c.card === true ? placeKeys.get(c.space) : null;
        if (k) put(asleep.filter((d) => d.after === k));
      }
      put(asleep);
      return res;
    };

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    // Inside a space card the sections read as small labels.
    const header = (g) => {
      const open = !this.isFolded(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      // Room above: a section in a card little, other groups more (not the first).
      const gap = g.parent ? 8 : groups[0] === g ? 8 : 20;
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(gap)
        .h(22 + gap)
        .flex_none()
        .gap(6)
        .items_center()
        // State and shelf names read as small uppercase labels; space names keep their case.
        .text_size(g.pic ? 11 : 10)
        .when(!g.pic, (el) => el.font_semibold())
        .when(Boolean(g.pic), (el) => el.font_medium())
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.toggleFold(g.id);
          cx.notify();
        })
        // A space header shows a "+" on hover: a new terminal or agent in that space.
        .when(Boolean(g.space), (el) => el.on_hover((on, cx) => {
          if (on) this.hoveredHeader = g.id;
          else if (this.hoveredHeader === g.id) this.hoveredHeader = null;
          cx.notify();
        }))
        .when(Boolean(g.pic), (el) => el.child(g.pic))
        .child(div().truncate().when(!g.pic, (el) => el.font_family(LABEL_FONT).font_bold()).text_color(g.color ?? (g.status === "idle" ? t.muted : t[g.status]) ?? t.dim).child(g.pic ? g.label : g.label.toUpperCase()))
        .when(Boolean(g.space) && this.hoveredHeader === g.id, (el) => el.child(div()
          .id(`new-${g.id}`)
          .flex_none()
          .p(2)
          .rounded(4)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`New terminal or agent in ${g.label}`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            newIn(g.space, g.label);
          })
          .child(svg("mods/workspace-chrome/plus.svg").size(13))))
        .when(!open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when((Boolean(g.pic) || g.id === "archive" || g.id.endsWith(":archive")) && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    // inCard: a section of a space card is built even while the card is folded, so the
    // card can fold it away (and back) smoothly.
    const groupRows = (g, inCard = false) => {
      if (!inCard && g.parent && this.isFolded(g.parent)) return [];
      if (g.headerOnly) return [spaceHeader(g)];
      // A section in a card: 8 px above a 22 px label.
      const head = tall(header(g), 30);
      if (this.isFolded(g.id)) return [head];
      return [head, ...(g.terms ? g.members.map((it) => tall(this.termRow(t, it, true), 28)) : g.members.flatMap(withKids))];
    };
    // By space and status: the space's header, then its sections indented to the right
    // of a thread in the space's color that runs down from under its picture.
    const cards = () => {
      const out = [];
      let card = null;
      for (const g of groups) {
        if (g.headerOnly) {
          out.push((card = { card: true, id: g.id, space: g.space, head: groupRows(g), items: [] }));
          continue;
        }
        const mine = Boolean(card && g.parent === card.id);
        const rowsOf = groupRows(g, mine);
        if (mine) card.items.push(...rowsOf);
        else out.push(...rowsOf);
      }
      // Other machines' spaces go to the very top, under their machine's name, and only
      // while it is connected; this computer's spaces keep their place after Pinned.
      const remote = (c) => c.card === true && Boolean(machineOf(c.space));
      const top = connected.flatMap((m) => [m, ...out.filter((c) => remote(c) && machineOf(c.space) === m)]);
      // Folded spaces of this computer leave the list for the bottom, just above the
      // settings, and under them the closed places: out of the way. Unfolded or opened
      // again, a space is back in its place.
      const all = [...top, ...withDormant(out.filter((c) => !remote(c)))];
      const down = (c) => c.card === true && !remote(c) && this.isFolded(c.id);
      return {
        rows: draw(all.filter((c) => !down(c) && !c.dormant)),
        folded: draw([...all.filter(down), ...all.filter((c) => c.dormant)], 6),
      };
    };
    // gap: the room between two cards (12 in the list; folded ones at the bottom sit closer).
    const draw = (shown, gap = 12) => {
      return shown.map((c, i) => (typeof c === "string"
        ? machineHead(c, i)
        : c.dormant
        ? div().flex_none().mt(i && typeof shown[i - 1] !== "string" ? (shown[i - 1]?.dormant ? 2 : gap) : 2).child(dormantCard(c.dormant))
        : c.card === true
        ? v_flex().id(`space-${c.id}`).flex_none().mt(i && typeof shown[i - 1] !== "string" ? gap : 2)
          .children(c.head)
          .when(c.items.length > 0, (el) => {
            // The picture is 26 px wide at 7 px in: the 2 px thread runs under its middle.
            const body = v_flex().flex_none().ml(19).pl(9).pt(2).border_l(2)
              .border_color(spaceHex(c.space) + (c.space === activeSpace ? "bf" : "73")).children(c.items);
            // Folding slides the body's height to 0 and back. Every row's height is known,
            // else (a row without one) it opens and closes without the slide.
            const h = c.items.every((r) => typeof r._h === "number") ? 2 + c.items.reduce((n, r) => n + r._h, 0) : null;
            const open = !this.isFolded(c.id);
            if (h === null) return open ? el.child(body) : el;
            return el.child(div().id(`body-${c.id}`).flex_none().overflow_hidden().h(open ? h : 0)
              .transition("height", { duration: 240, easing: "ease-in-out" }).child(body));
          })
        : c));
    };
    // The rail: the spaces first (their picture, else their number), then the agents.
    // Another machine's spaces only while it is connected, and first.
    const railOrder = [...spaces().filter((s) => connected.includes(s.machine)), ...spaces().filter((s) => !s.machine)];
    const railSpaces = () => railOrder.map((s, i) => h_flex().id(`rail-${s.id}`).h(28).flex_none().justify_center().items_center()
      .when(s.id === activeSpace, (el) => el.bg(t.raised))
      .hover((st) => st.bg(t.hover))
      .tooltip(s.name)
      .on_click(() => run("space.select", { id: s.id }))
      .child(spacePic({ space: s.id, space_name: s.name }, 18)))
      .concat(railOrder.length ? [div().h(1).mx(8).my(4).flex_none().bg(t.border)] : []);
    const carded = !collapsed && bySpaceStatus ? cards() : null;
    const rows = collapsed
      ? [...railSpaces(), ...list.flatMap(withKids)]
      : carded ? carded.rows : [...groups.flatMap(groupRows), ...this.terminalRows(t)];
    const folded = carded?.folded ?? [];
    // A drag that ends outside a space header drops nothing.
    const dropNothing = (_e, cx) => { if (this.pressed !== null) { this.pressed = null; this.over = null; cx.notify(); } };
    const topBtn = (id, tip, icon, onClick) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(onClick).child(svg(icon).size(14));

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .pl(16)
            .pr(10)
            .h(34)
            .flex_none()
            .gap(2)
            .items_center()
            .text_size(11.5)
            .text_color(t.dim)
            .child(div().flex_1().child(bySpaceStatus ? "Spaces" : "Agents"))
            .child(topBtn("ag-sort", `Sort agents: ${sort.label}`, `mods/workspace-chrome/${sort.icon}.svg`,
              () => openOverlay({ mod: "agents-icons", kind: "popup", width: 200, height: 175, props: { sortMenu: true } })))
            .child(topBtn("space-new", "New space", "mods/workspace-chrome/plus.svg", () => run("space.new"))),
        ),
      )
      .when(list.length === 0 && !collapsed && rows.length === 0 && folded.length === 0, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", dropNothing)
        .children(rows))
      // The folded spaces, at the bottom right above the settings, as tall as they are (a
      // scroll area here kept its full height and left a gap); many of them shrink the list.
      .when(folded.length > 0, (el) => el.child(v_flex().id("ag-folded").flex_none().px(8).pt(6).pb(4)
        .on_mouse_up("left", dropNothing)
        .children(folded)))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
