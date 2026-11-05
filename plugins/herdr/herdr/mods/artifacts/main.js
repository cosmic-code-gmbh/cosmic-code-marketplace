// Artifacts dropdown, opened as a popup by the "Artefakte" button in mods/tabs-run with
// props { terminal } = the terminal that had the focus. Two sources in ~/.local/state/herdr-artifacts:
//   artifacts.jsonl  what Claude Code publishes, live, via the herdr plugin's hook (hooks/bridge.ts)
//   catalog.jsonl    a snapshot of all claude.ai artifacts that Claude writes when asked
//                    ("Artefakte aktualisieren"); its claude.ai pins seed the pins once
// Sections: this terminal's newest Claude session, pinned (shared "artifacts.pins"), the latest
// RECENT others; typing searches all of them. A click opens the artifact in the default browser.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, exec, home, props, readTextFile, setShared, shared, theme } from "herdr";

const DIR = `${home()}/.local/state/herdr-artifacts`;
const RECENT = 20;
const HITS = 50;
const PINS = "artifacts.pins";
const SEEDED = "artifacts.pinsSeeded";

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return new Date(at).toLocaleDateString("de-DE");
}

function base(path) {
  return path ? path.replace(/\/+$/, "").split("/").pop() : "";
}

async function readLines(file) {
  const text = await readTextFile(file).catch(() => null);
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// Every known artifact, newest first, one per url. Hook lines win over the catalog (they carry
// the terminal); a republish keeps its first session.
async function loadArtifacts() {
  const byUrl = new Map();
  for (const e of await readLines(`${DIR}/catalog.jsonl`)) byUrl.set(e.url, { ...e, first: e.at });
  for (const e of await readLines(`${DIR}/artifacts.jsonl`)) {
    const prev = byUrl.get(e.url);
    if (!prev) byUrl.set(e.url, { ...e, first: e.at });
    else if (prev.source === "claude.ai") byUrl.set(e.url, { ...prev, ...e, cwd: e.cwd ?? prev.cwd, path: e.path ?? prev.path, source: undefined, first: e.at });
    else byUrl.set(e.url, { ...e, session: prev.session, terminal: prev.terminal, first: prev.first });
  }
  return [...byUrl.values()].sort((a, b) => b.at - a.at);
}

// claude.ai pins become pins here once; after that the pins are the user's own.
function seedPins(entries) {
  if (shared(SEEDED)) return;
  const pins = shared(PINS) ?? [];
  const have = new Set(pins.map((p) => p.url));
  const add = entries.filter((e) => e.pinned && !have.has(e.url)).map((e) => ({ url: e.url, title: e.title, path: e.path, cwd: e.cwd, at: e.at }));
  if (!entries.some((e) => e.source === "claude.ai")) return; // no catalog yet
  setShared(PINS, [...pins, ...add]);
  setShared(SEEDED, true);
}

function matches(e, words) {
  const hay = `${e.title} ${base(e.cwd)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// The artifacts of the newest Claude session that ran in `terminal`.
function sessionOf(entries, terminal) {
  const mine = entries.filter((e) => terminal && e.terminal === terminal);
  const session = mine.reduce((best, e) => (e.first > (best?.first ?? 0) ? e : best), null)?.session;
  return session ? mine.filter((e) => e.session === session) : [];
}

// The system's default browser.
function openWindow(url) {
  exec("open", [url]);
}

const ICON = (name) => `mods/artifacts/${name}.svg`;

// A theme color with alpha, for tinted tiles; leaves non-#rrggbb values alone.
function tint(color, alpha) {
  return /^#[0-9a-f]{6}$/i.test(color ?? "") ? `${color}${alpha}` : color;
}

// One stable accent per project folder, from the theme's ANSI colors.
function hue(t, key) {
  const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1].filter(Boolean);
  let h = 0;
  for (const ch of key ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette.length ? palette[h % palette.length] : t.accent;
}

export default class Artifacts extends View {
  init(_props, cx) {
    this.entries = null;
    this.query = "";
    this.at = 0; // keyboard selection in the visible list
    this.hover = null;
    this.flat = [];
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Artefakte suchen …" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", () => {
      const e = this.flat[this.at];
      if (e) this.open(e);
    });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    cx.spawn(async (cx) => {
      this.entries = await loadArtifacts();
      seedPins(this.entries);
      cx.notify();
    });
  }

  open(e) {
    openWindow(e.url);
    closeOverlay(props()?.overlay);
  }

  togglePin(e) {
    const pins = shared(PINS) ?? [];
    const on = pins.some((p) => p.url === e.url);
    setShared(PINS, on ? pins.filter((p) => p.url !== e.url) : [{ url: e.url, title: e.title, path: e.path, cwd: e.cwd, at: e.at }, ...pins]);
  }

  row(e, t, pinned, selected) {
    const color = hue(t, base(e.cwd) || "claude.ai");
    const hot = selected || this.hover === e.url;
    return h_flex()
      .id(`a-${e.url}`)
      .h(46)
      .px(8)
      .gap(10)
      .items_center()
      .flex_none()
      .rounded(8)
      .cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((hovered, cx) => {
        this.hover = hovered ? e.url : this.hover === e.url ? null : this.hover;
        cx.notify();
      })
      .on_click(() => this.open(e))
      .child(
        div()
          .size(30)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(8)
          .bg(tint(color, "26"))
          .text_color(color)
          .child(svg(ICON("page")).size(16)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().truncate().text_size(13).font_medium().text_color(t.foreground).child(e.title))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .text_size(11)
              .text_color(t.dim)
              .child(div().flex_none().text_color(color).child(base(e.cwd) || "claude.ai"))
              .child(div().flex_none().child("·"))
              .child(div().truncate().child(ago(e.at))),
          ),
      )
      .when(pinned || hot, (el) =>
        el.child(
          div()
            .id(`p-${e.url}`)
            .size(26)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(6)
            .text_color(pinned ? t.accent : t.dim)
            .hover((s) => s.bg(t.raised).text_color(pinned ? t.accent : t.foreground))
            .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
            .on_click((_ev, cx) => {
              cx.stop_propagation();
              this.togglePin(e);
            })
            .child(svg(ICON("pin")).size(14)),
        ),
      )
      .when(hot, (el) => el.child(div().flex_none().text_color(t.dim).child(svg(ICON("open")).size(14))));
  }

  section(label, list, t, pinUrls, opts = {}) {
    if (!list.length) return null;
    const start = this.flat.length;
    this.flat.push(...list);
    return v_flex()
      .flex_none()
      .gap(1)
      .child(
        h_flex()
          .px(10)
          .pt(10)
          .pb(4)
          .gap(6)
          .items_center()
          .text_size(11)
          .font_semibold()
          .text_color(t.muted)
          .when(Boolean(opts.live), (el) => el.child(div().size(6).rounded(3).bg(t.working ?? t.accent)))
          .child(div().flex_1().child(label))
          .child(div().text_color(t.dim).font_normal().child(opts.count ?? String(list.length))),
      )
      .children(list.map((e, i) => this.row(e, t, pinUrls.has(e.url), start + i === this.at)));
  }

  render() {
    const t = theme();
    const entries = this.entries ?? [];
    const pins = shared(PINS) ?? [];
    const pinUrls = new Set(pins.map((p) => p.url));
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    this.flat = [];

    let sections;
    if (words.length) {
      const hits = entries.filter((e) => matches(e, words));
      sections = [this.section("Treffer", hits.slice(0, HITS), t, pinUrls, { count: hits.length > HITS ? `${HITS} von ${hits.length}` : String(hits.length) })];
    } else {
      const session = sessionOf(entries, props()?.terminal);
      const seen = new Set(session.map((e) => e.url));
      // A pinned artifact shows its newest known state when there is one.
      const pinned = pins.map((p) => entries.find((e) => e.url === p.url) ?? p).filter((e) => !seen.has(e.url));
      for (const e of pinned) seen.add(e.url);
      const recent = entries.filter((e) => !seen.has(e.url)).slice(0, RECENT);
      sections = [
        this.section("Diese Session", session, t, pinUrls, { live: true }),
        this.section("Angepinnt", pinned, t, pinUrls),
        this.section("Zuletzt", recent, t, pinUrls),
      ];
    }
    sections = sections.filter(Boolean);
    if (this.at >= this.flat.length) this.at = Math.max(0, this.flat.length - 1);
    const empty = words.length ? "Nichts gefunden." : "Noch keine Artefakte aufgezeichnet.";
    const key = (k) => div().px(5).rounded(4).bg(t.raised).text_color(t.muted).child(k);

    // A popup has no height for flex to fill: give the root one (as the shipped new-menu does),
    // a little under the popup's 560 from mods/tabs-run.
    return v_flex()
      .id("artifacts-root")
      .track_focus(this.handle)
      .w_full()
      .h(536)
      .min_h(0)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((ev, cx) => {
        const n = this.flat.length;
        if (ev.key === "escape") return closeOverlay(props()?.overlay);
        if (!n) return;
        if (ev.key === "down") this.at = (this.at + 1) % n;
        else if (ev.key === "up") this.at = (this.at + n - 1) % n;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .flex_none()
          .m(8)
          .mb(2)
          .h(38)
          .px(12)
          .gap(9)
          .items_center()
          .rounded(10)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .cursor_text()
          .child(div().flex_none().text_color(t.dim).child(svg(ICON("search")).size(16)))
          .child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(t.foreground))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(this.entries ? String(entries.length) : "…")),
      )
      .child(
        v_flex()
          .id("artifacts-list")
          .flex_1()
          .min_h(0)
          .px(6)
          .pb(6)
          .overflow_y_scrollbar()
          .when(this.entries !== null && sections.length === 0, (el) => el.child(div().p(14).text_color(t.dim).child(empty)))
          .children(sections),
      )
      .child(
        h_flex()
          .flex_none()
          .h(30)
          .px(12)
          .gap(12)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child(h_flex().gap(4).items_center().child(key("↑↓")).child("wählen"))
          .child(h_flex().gap(4).items_center().child(key("↵")).child("öffnen"))
          .child(h_flex().gap(4).items_center().child(svg(ICON("pin")).size(11)).child("anpinnen"))
          .child(div().flex_1())
          .child(h_flex().gap(4).items_center().child(key("esc")).child("schließen")),
      );
  }
}
