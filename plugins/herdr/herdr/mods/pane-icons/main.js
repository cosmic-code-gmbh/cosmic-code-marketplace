// pane-icons: Marcus' copy of Herdr's pane header (Herdr replaces its own `pane` on start).
// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-icons" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// A Claude Code pane also shows its model · effort and context meter on the right, from
// ~/.local/state/herdr-session-bar/<terminal>.json (session-bar's Claude Code plugin);
// a click opens session-bar-icons' Claude card. The bottom bar no longer shows them.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, readTextFile, watchFolder, openOverlay } from "herdr";

const infoDir = () => `${home()}/.local/state/herdr-session-bar`;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// "claude-opus-5-5[1m]" → "Opus 5.5"; anything else as given.
function modelName(id) {
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)?(?:[-.](\d+))?/i.exec(id ?? "");
  if (!m) return id ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ""}` : ""}`;
}

const isClaude = (p) => Boolean(p && (p.app === "claude-code" || p.program?.key === "claude"));

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.info = null;
    // The plugin rewrites the file after every turn; read ours when the folder changes.
    cx.spawn(async (cx) => {
      this.readInfo(cx);
      try { for (;;) { await watchFolder(infoDir()); this.readInfo(cx); } } catch {}
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  readInfo(cx) {
    const p = this.me();
    const term = p?.terminal;
    if (!term || term.includes("/") || !isClaude(p)) { if (this.info) { this.info = null; cx.notify(); } return; }
    cx.spawn(async (cx) => {
      let info = null;
      try { info = JSON.parse((await readTextFile(`${infoDir()}/${term}.json`)) ?? "null"); } catch {}
      this.info = info;
      cx.notify();
    });
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-icons/${icon}.svg`).size(14));
  }

  // Model · effort and the context meter; a click opens the Claude card (all meters).
  claude(t, pane) {
    const i = this.info;
    if (!i?.model) return null;
    const ctx = (i.meters ?? []).find((m) => m.label === "ctx");
    const pct = ctx?.percent ?? null;
    const color = pct >= 95 ? t.ansi1 : pct >= 80 ? t.ansi3 : t.ansi6;
    const card = 24 + 14 + 9 + 18 + (i.meters?.length ?? 0) * 27 + (i.at ? 24 : 0) + 12;
    return h_flex().id(`ph-claude-${pane}`).flex_none().h(20).px(6).gap(7).items_center().rounded(5)
      .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(i.model)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "session-bar-icons", kind: "popup", width: 280, height: card, props: { popup: { kind: "claude", info: i, router: null } } });
      })
      .child(div().text_color(t.muted).child(modelName(i.model)))
      .when(Boolean(i.effort), (el) => el.child(div().text_color(t.dim).child(i.effort)))
      .when(pct !== null, (el) => el
        .child(div().w(34).h(4).flex_none().rounded(2).bg(t.raised).child(div().h_full().rounded(2).w(Math.max(pct > 0 ? 2 : 0, (34 * pct) / 100)).bg(color)))
        .child(div().text_color(t.dim).child(`${pct}%`)));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // Another program in this pane now, or a new terminal: read again.
    const key = `${p.terminal}|${isClaude(p)}`;
    if (key !== this.infoKey) { this.infoKey = key; this.readInfo(cx); }
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(isClaude(p) && Boolean(this.info?.model), (el) => el.child(this.claude(t, pane)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
