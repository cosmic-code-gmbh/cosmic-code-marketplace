import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, layout, settings, home, readTextFile, watchFolder } from "herdr";
// Copy of mods/run-scripts/scripts.js (a mod can only import from its own folder).
import { findProject, control } from "./scripts.js";

// Clone of the shipped `tabs` mod with the run-scripts control ("▾ script ▶") at the right
// end of the bar, after Files/Changes, an "Artefakte" dropdown (mods/artifacts) before them, and
// a "Fokus" panel button (mods/fokus) that counts the focused Claude session's open questions.
// Used by layouts/main-filetree.json.

const FOKUS = `${home()}/.local/state/fokusboard`;

// The focused terminal's folder (or the space's), and its machine, like run-scripts' bar.
function where() {
  const f = focused(), space = spaces().find((s) => s.active);
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal && p.cwd) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd ?? f?.cwd ?? space?.folder ?? null, on };
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
    cx.timer.every(15000, (cx) => this.detect(cx, true));
    cx.spawn(async (cx) => {
      for (;;) {
        await this.countQuestions(cx);
        try { await watchFolder(FOKUS); } catch { await new Promise((r) => cx.timer.after(5000, r)); }
      }
    });
  }

  // Open questions on the focused terminal's Fokusboard, for the badge on the Fokus button
  async countQuestions(cx) {
    const terminal = focused()?.terminal ?? this.fokus?.terminal ?? null;
    if (!terminal) return;
    const text = await readTextFile(`${FOKUS}/${terminal}.json`).catch(() => null);
    let board = null;
    try { board = text && JSON.parse(text); } catch {}
    if (!board && this.fokus) return; // not a Claude terminal: keep the last count
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
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
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
    const fokusBadge = this.fokus?.open ? { count: this.fokus.open, color: this.fokus.blocking ? t.blocked : "#D97757" } : null;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
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
