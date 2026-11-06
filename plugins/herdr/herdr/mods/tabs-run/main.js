import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, layout, settings, home, readTextFile, watchFolder, exec } from "herdr";
// Copy of mods/run-scripts/scripts.js (a mod can only import from its own folder).
import { findProject, control } from "./scripts.js";

// Clone of the shipped `tabs` mod with the run-scripts control ("▾ script ▶") at the right
// end of the bar, after Files/Changes, an "Artefakte" dropdown (mods/artifacts) before them, and
// a "Fokus" panel button (mods/fokus) that counts the focused Claude session's open questions.
// Tabs nobody named take the name of their Claude session's Fokusboard thread, kept up to date;
// a name someone typed is left alone. Each Claude tab shows its open questions as a red badge.
// A speaker button mutes the Claude Code sounds (~/.claude/hooks/wc3-sound.sh): it
// creates or removes MUTED, which the hook checks before playing.
// Used by layouts/main-filetree.json.

const FOKUS = `${home()}/.local/state/fokusboard`;
const MUTED = `${home()}/.claude/sounds/wc3/.muted`;
// Only a guard against runaway titles: the tab bar and the Agents list cut names by
// their width, so a wider sidebar shows more.
const TAB_NAME_MAX = 120;

// "herdr-Plugin für Claude-Artefakte" → whitespace tidied; past TAB_NAME_MAX cut at a word
function shortName(text) {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= TAB_NAME_MAX) return clean;
  const cut = clean.slice(0, TAB_NAME_MAX - 1);
  return (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut) + "…";
}

// The focused terminal's folder (or the space's), and its machine, like run-scripts' bar.
function where() {
  const f = focused(), space = spaces().find((s) => s.active);
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal && p.cwd) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd ?? f?.cwd ?? space?.folder ?? null, on };
}

// What a tab is called when nobody named it: the agent's own terminal title when it
// says something (Claude sets one per conversation), else the program. The same rule
// as agents-icons' title(), so the bar and the Agents list read alike.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
function liveTitle(pane) {
  const live = clean(pane?.title);
  const prog = pane?.program;
  const telling = live && live !== prog?.name && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== prog?.key;
  return telling ? live : null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.project = null;
    this.fokus = null; // { terminal, open, blocking } of the focused terminal's Fokusboard
    // tab id → the names this mod gave it, newest last. Older ones count too: a rename
    // that never landed must not make the tab look named by hand.
    this.autoNames = JSON.parse(localStorage.getItem("autoNames") ?? "{}");
    for (const [id, v] of Object.entries(this.autoNames)) if (!Array.isArray(v)) this.autoNames[id] = [v];
    this.questions = {}; // tab id → open questions on its Claude session's Fokusboard
    cx.timer.every(15000, (cx) => this.detect(cx, true));
    this.muted = false;
    cx.spawn(async (cx) => {
      this.muted = (await exec("test", ["-e", MUTED]).catch(() => ({ code: 1 }))).code === 0;
      cx.notify();
    });
    // A board change wakes this at once. The look every 5 s catches what the watch
    // can't: a change between reading and watching again, and a tab whose agent
    // Herdr only recognised after its board was written (a new tab, a restart).
    cx.spawn(async (cx) => {
      for (;;) {
        await this.refresh(cx);
        try { await watchFolder(FOKUS); } catch { await new Promise((r) => cx.timer.after(5000, r)); }
      }
    });
    cx.timer.every(5000, (cx) => { cx.spawn(async (cx) => this.refresh(cx)); });
  }

  // One look at a time; nothing that fails ends the watch loop.
  async refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.countQuestions(cx);
      await this.readTabs(cx);
    } catch {}
    this.refreshing = false;
  }

  // Reads each Claude tab's Fokusboard: its open questions for the badge, and its thread as the
  // tab's name unless someone named the tab
  async readTabs(cx) {
    const all = spaces().flatMap((sp) => sp.tabs ?? []);
    const questions = {};
    let named = false;
    for (const tab of all) {
      const agent = panes().find((p) => p.tab === tab.id && p.terminal && p.program?.agent);
      if (!agent) continue;
      const text = await readTextFile(`${FOKUS}/${agent.terminal}.json`).catch(() => null);
      let board = null;
      try { board = text && JSON.parse(text); } catch {}
      if (!board) continue;
      const open = board.ended ? 0 : (board.decisions ?? []).length;
      if (open) questions[tab.id] = open;
      // Unnamed, named by this mod, or named after its program ("Claude Code", as the new-tab menu does)
      const given = this.autoNames[tab.id] ?? [];
      const isDefault = !tab.named || given.includes(tab.name) || tab.name === agent.program.name;
      const name = shortName(board.thread?.title ?? board.topic?.title);
      if (!isDefault || !name || name === tab.name) continue;
      run("tab.rename", { id: tab.id, name });
      this.autoNames[tab.id] = [...given.filter((n) => n !== name), name].slice(-10);
      named = true;
    }
    // Forget tabs that are gone
    for (const id of Object.keys(this.autoNames)) if (!all.some((tab) => tab.id === id)) { delete this.autoNames[id]; named = true; }
    if (named) localStorage.setItem("autoNames", JSON.stringify(this.autoNames));
    if (JSON.stringify(questions) !== JSON.stringify(this.questions)) {
      this.questions = questions;
      cx.notify();
    }
  }

  // Open questions on the focused terminal's Fokusboard, for the badge on the Fokus button
  async countQuestions(cx) {
    // Each terminal tab counts its own board; with no terminal focused the last count stays
    const terminal = focused()?.terminal ?? this.fokus?.terminal ?? null;
    if (!terminal) return;
    const text = await readTextFile(`${FOKUS}/${terminal}.json`).catch(() => null);
    let board = null;
    try { board = text && JSON.parse(text); } catch {}
    if (terminal !== (focused()?.terminal ?? terminal)) return; // the focus moved on while reading
    const list = board?.ended ? [] : board?.decisions ?? [];
    this.fokus = { terminal, open: list.length, blocking: list.filter((d) => d.weight === "blocking").length };
    cx.notify();
  }

  // Looks for package.json again when the focused folder changes, and every 15 s for edits.
  detect(cx, force = false) {
    const { cwd, on } = where(), key = JSON.stringify([cwd, on]);
    if ((key === this.key && !force) || this.detecting) return;
    this.key = key; this.detecting = true;
    cx.spawn(async (cx) => {
      try { const p = await findProject(cwd, on); if (this.key === key) this.project = p; }
      catch { if (this.key === key) this.project = null; }
      finally { this.detecting = false; cx.notify(); }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    this.detect(cx);
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      // An unnamed tab (called by its position, "2") or one named after its program
      // shows the agent's live title, else its program
      const name = !c.named || /^tb\d+$/.test(c.name) || c.name === program?.name ? liveTitle(lead) ?? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(Boolean(this.questions[c.id]), el => el.child(div().flex_none().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(8)
          .bg(t.blocked).text_color(t.solid_foreground ?? t.background).text_size(10.5).font_semibold().child(String(this.questions[c.id]))))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "fokus"];
    if (focused()?.terminal && focused().terminal !== this.fokus?.terminal) cx.spawn(async (cx) => this.countQuestions(cx));
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon, badge) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label)
        .when(Boolean(badge), el => el.child(div().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(8)
          .bg(badge.color).text_color(t.solid_foreground ?? t.background).text_size(10.5).font_semibold().child(String(badge.count))));
    };
    const fokusBadge = this.fokus?.open ? { count: this.fokus.open, color: t.blocked } : null;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(div().id("sound").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(this.muted ? t.blocked : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .tooltip(this.muted ? "Sounds are off: click to turn them on" : "Mute Claude sounds")
        .on_click((_e, cx) => {
          const on = !this.muted;
          this.muted = on;
          cx.notify();
          cx.spawn(async (cx) => {
            // fs writes only under the app home: the file is made and removed by exec.
            const r = on ? await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && touch "$1"', "sh", MUTED]) : await exec("rm", ["-f", MUTED]);
            if (r.code !== 0) { this.muted = !on; cx.notify(); }
          });
        })
        .child(svg(`mods/tabs-run/${this.muted ? "volume-x" : "volume-2"}.svg`).size(15)))
      .child(h_flex().id("artifacts").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(t.chrome).text_color(t.muted).hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "artifacts", kind: "popup", width: 400, height: 560, props: { terminal: focused()?.terminal ?? null } }))
        .child("Artefakte").child(svg("mods/files/chevron-down.svg").size(12)))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(Boolean(find(root, "fokus")), el => el.child(panelButton("fokus", "Fokus", "mods/fokus/focus.svg", fokusBadge)))
      .when(Boolean(this.project), el => el.child(div().ml(5).flex_none().child(control(t, 6, this.project, { height: 26, stop }))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-run/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-run/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-run/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
