// Fokus: the Fokusboard of the Claude Code session in the focused terminal, as the third tab of
// the right panel (layouts/main-filetree.json, stack "panel-body", child "fokus").
//
//   fokusboard mod (Claude Code) ──writes──► ~/.local/state/fokusboard/<terminal>.json ──watch──► here
//   here ──appends {at, do, …}──► ~/.local/state/fokusboard/<terminal>.inbox.jsonl ──► fokusboard mod
//
// The Claude Code mod owns the board and carries out every click (fill the prompt box, ask,
// explain, Griffe …), so this view only draws and sends intents. It shows one session, calmly:
//
//   thread title ··●        head: what the conversation is about, one dot per topic
//   JETZT                   the current topic
//   FRAGEN                  open questions, one row per answer
//   TODOS ━━━━━━──── 3/5    every todo; finished ones can be hidden
//   PLÄNE                   plan files as a tree: plan, review, verify with versions
//   ARTEFAKTE               links with kind and host
//   GRIFFE                  prompts sent again and again
//   SESSION                 who held the ball when, sampled here from the agent's status
//
// No frames, no glow: sections are told apart by space and their labels. Colors come from the
// Herdr theme the person picked in the settings; there is no picker of its own. Text sizes follow
// the golden ratio: 10 (labels, meta) and 16 (text). Icons are the one-color "Linse" set (l-*.svg).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, exec, focused, home, readTextFile, theme, watchFolder, writeTextFile } from "herdr";

const DIR = `${home()}/.local/state/fokusboard`;
const ARTIFACTS = `${home()}/.local/state/herdr-artifacts/artifacts.jsonl`;
const ICON = (name) => `mods/fokus/l-${name}.svg`;
const MONO = "Geist Mono";
// Golden-ratio type scale: labels and meta, text
const XS = 10;
const S = 16;
const KEEP_INTENTS = 30;
// Session sampling: how often, how far back, and when waiting on you turns into a pause
const SAMPLE_MS = 5000;
const WINDOW_MS = 2 * 3600_000;
const PAUSE_AFTER_MS = 10 * 60_000;

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
}

const since = (at) => (at ? ago(at).replace(/^vor /, "seit ") : "");

// "1 h 05 min", "12 min"
function span(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

// A #rrggbb color with alpha (two hex digits), for tinted surfaces; other values stay as they are
function tint(color, alpha) {
  return /^#[0-9a-f]{6}$/i.test(color ?? "") ? `${color}${alpha}` : color;
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function load(key, fallback) {
  try {
    return readJson(localStorage.getItem(key) ?? "") ?? fallback;
  } catch {
    return fallback;
  }
}

// What kind of link an artifact is, from its URL (mirrors fokusboard's artifactKind)
function kindOf(href) {
  if (/claude\.ai\/(code\/)?artifact\//.test(href)) return "artefakt";
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(href)) return "pr";
  return "doc";
}

function hostOf(href) {
  const pr = href.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  if (pr) return `github · ${pr[1]} #${pr[2]}`;
  const m = href.match(/^[a-z]+:\/\/([^/]+)/i);
  if (m && !href.startsWith("file:")) return m[1].replace(/^www\./, "");
  return href.split("/").filter(Boolean).slice(-2, -1)[0] ?? href;
}

// This session's publishes: the hook lines of `terminal` from its newest Claude session
async function hookArtifacts(terminal) {
  const text = await readTextFile(ARTIFACTS).catch(() => null);
  const lines = (text ?? "").split("\n").map(readJson).filter((e) => e && e.terminal === terminal);
  const session = lines.at(-1)?.session;
  const seen = new Set();
  return lines
    .filter((e) => e.session === session)
    .reverse()
    .filter((e) => !seen.has(e.url) && seen.add(e.url))
    .map((e) => ({ label: e.title, href: e.url, at: e.at }));
}

// One beat of an agent's status into its timeline: "w" Claude works, "y" the ball is with you
function addSample(list, state, now) {
  const last = list.at(-1);
  if (last && last.k === state && now - last.to <= SAMPLE_MS * 3) return [...list.slice(0, -1), { ...last, to: now }];
  return [...list, { k: state, from: now, to: now }].filter((x) => now - x.to < WINDOW_MS + 3600_000).slice(-400);
}

// The timeline as Claude / you / pause, within the last two hours: waiting on you longer than
// ten minutes counts as a pause from then on
function ballSegments(list, now) {
  const start = now - WINDOW_MS;
  const out = [];
  for (const x of list) {
    const from = Math.max(x.from, start);
    if (x.to <= from) continue;
    if (x.k === "w") out.push({ k: "C", from, to: x.to });
    else {
      const cut = Math.min(x.to, Math.max(from, x.from + PAUSE_AFTER_MS));
      if (cut > from) out.push({ k: "D", from, to: cut });
      if (x.to > cut) out.push({ k: "R", from: cut, to: x.to });
    }
  }
  return out;
}

export default class Fokus extends View {
  init(_props, cx) {
    this.terminal = null; // the terminal whose board is shown
    this.tried = null; // the focused terminal last looked at
    this.board = null;
    this.published = [];
    this.hover = null;
    this.view = load("view", { hideDone: false });
    // Per terminal: [{k: "w"|"y", from, to}], kept across restarts of the app
    this.timeline = load("timeline", {});
    this.isAdding = false;
    this.input = InputState.new({ placeholder: "Befehl, z. B. /simplify" });
    this.input.on("submit", (_e, cx) => {
      const text = this.input.value().trim();
      if (text) this.send({ do: "griff.add", text });
      this.input.set_value("");
      this.isAdding = false;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", DIR]).catch(() => null);
      await this.follow(cx);
      for (;;) {
        try {
          await watchFolder(DIR);
        } catch {}
        await this.follow(cx);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(`${home()}/.local/state/herdr-artifacts`);
        } catch {}
        await this.load(cx);
      }
    });
    // "vor 2 min" moves on without a write
    cx.timer.every(15000, (cx) => cx.notify());
    // Who holds the ball: sampled for every Claude session, drawn for the shown one (no redraw here)
    cx.timer.every(SAMPLE_MS, () => this.sample());
  }

  sample() {
    const now = Date.now();
    for (const a of agents()) {
      if (!(a.app === "claude-code" || a.program?.key === "claude")) continue;
      const state = a.status === "working" ? "w" : "y";
      this.timeline[a.address] = addSample(this.timeline[a.address] ?? [], state, now);
    }
    try {
      localStorage.setItem("timeline", JSON.stringify(this.timeline));
    } catch {}
  }

  // Follows the focused terminal: each tab shows its own session's board, or none. Only while no
  // terminal has the focus (a click into this panel, a mod pane) does the last board stay.
  async follow(cx) {
    const t = focused()?.terminal ?? null;
    this.tried = t;
    if (t) this.terminal = t;
    await this.load(cx);
  }

  async load(cx) {
    if (!this.terminal) return;
    const terminal = this.terminal;
    const text = await readTextFile(`${DIR}/${terminal}.json`).catch(() => null);
    const published = await hookArtifacts(terminal);
    if (terminal !== this.terminal) return; // the focus moved on while reading
    this.board = (text && readJson(text)) ?? null;
    this.published = published;
    cx.notify();
  }

  // Appends one click for the Claude Code mod; it reads the inbox every second
  async send(intent) {
    if (!this.terminal) return;
    const path = `${DIR}/${this.terminal}.inbox.jsonl`;
    for (let i = 0; i < 3; i++) {
      const before = await readTextFile(path).catch(() => null);
      const lines = (before ?? "").split("\n").filter(Boolean).slice(-KEEP_INTENTS);
      lines.push(JSON.stringify({ at: Date.now(), ...intent }));
      try {
        await writeTextFile(path, lines.join("\n") + "\n", before);
        return;
      } catch {} // written in between: read again
    }
  }

  setView(key, value) {
    this.view = { ...this.view, [key]: value };
    try {
      localStorage.setItem("view", JSON.stringify(this.view));
    } catch {}
  }

  // ── pieces ──────────────────────────────────────────────────────────────────

  // Small mono text for labels and meta
  meta(color, text) {
    return div().flex_none().font_family(MONO).text_size(XS).text_color(color).child(text);
  }

  // A section label: semibold mono caps; something quiet may sit on the right
  label(t, text, right) {
    return h_flex()
      .flex_none()
      .gap(8)
      .items_center()
      .mb(10)
      .child(div().flex_none().font_family(MONO).text_size(XS).font_semibold().text_color(t.foreground).child(text.toUpperCase()))
      .child(div().flex_1())
      .when(Boolean(right), (el) => el.child(right));
  }

  // A quiet text link in mono
  quiet(t, id, text, onClick) {
    return div()
      .id(id)
      .flex_none()
      .font_family(MONO)
      .text_size(XS)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(text);
  }

  section(child) {
    return v_flex().flex_none().pt(26).child(child);
  }

  head(t, b) {
    const title = b.thread?.title ?? b.topic?.title ?? "";
    const trail = b.trail ?? [];
    const dots = [...trail.map((x) => x.title), ...(b.topic ? [b.topic.title] : [])].slice(-5);
    return h_flex()
      .id("head")
      .flex_none()
      .pt(16)
      .gap(12)
      .items_start()
      .when(Boolean(b.thread?.goal), (el) => el.tooltip(b.thread.goal))
      .child(div().flex_1().min_w(0).text_size(S).font_semibold().line_height(1.3).text_color(t.foreground).child(title))
      .when(dots.length > 1, (el) =>
        el.child(
          h_flex()
            .id("topic-dots")
            .flex_none()
            .pt(7)
            .gap(4)
            .tooltip(`${dots.length} Themen: ${dots.join(" → ")}`)
            .children(dots.map((_, i) => div().size(6).rounded(3).bg(i === dots.length - 1 ? t.accent : t.dim))),
        ),
      );
  }

  now(t, tp) {
    return v_flex()
      .flex_none()
      .pt(20)
      .gap(8)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(svg(ICON("jetzt")).size(14).text_color(t.accent))
          .child(div().font_family(MONO).text_size(XS).font_semibold().text_color(t.accent).child("JETZT"))
          .child(div().flex_1())
          .child(this.meta(t.dim, since(tp.at))),
      )
      .child(div().text_size(S).font_bold().line_height(1.3).text_color(t.foreground).child(tp.title))
      .child(div().text_size(S).line_height(1.45).text_color(t.muted).child(tp.summary))
      .when(tp.points?.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(6)
            .pt(2)
            .children(
              tp.points.map((p) =>
                h_flex()
                  .gap(10)
                  .items_start()
                  .child(svg(ICON("jetzt")).mt(4).size(12).flex_none().text_color(t.accent))
                  .child(div().flex_1().min_w(0).text_size(S).line_height(1.4).text_color(t.muted).child(p)),
              ),
            ),
        ),
      );
  }

  // One open question: kind and age, the question and its context, one row per answer with its
  // note (the recommended one tinted), then the quiet actions on a strip of their own
  question(t, d) {
    const weight = d.weight ?? "important";
    const tag = {
      blocking: { label: "Blockiert", icon: "blockiert", color: t.blocked ?? t.ansi1 },
      important: { label: "Wichtig", icon: "wichtig", color: t.ansi3 },
      optional: { label: "Optional", icon: "optional", color: t.dim },
    }[weight];
    const isBlocking = weight === "blocking";
    const answers = (d.options ?? []).map((o, i) => ({ o, note: d.notes?.[i] ?? "", i }));
    const answer = ({ o, note, i }) => {
      const isRec = o === d.recommended;
      return h_flex()
        .id(`opt-${d.id}-${i}`)
        .px(12)
        .py(10)
        .gap(12)
        .items_center()
        .rounded(10)
        .cursor_pointer()
        .bg(isRec ? tint(t.accent, "26") : t.background)
        .hover((s) => s.bg(isRec ? tint(t.accent, "38") : t.hover))
        .on_click(() => this.send({ do: "answer", id: d.id, option: o }))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(3)
            .child(div().text_size(S).font_medium().line_height(1.3).text_color(t.foreground).child(o))
            .when(Boolean(note), (el) => el.child(div().font_family(MONO).text_size(XS).line_height(1.4).text_color(t.muted).child(note))),
        )
        .when(isRec, (el) =>
          el.child(div().flex_none().px(8).py(4).rounded(10).bg(tint(t.accent, "33")).font_family(MONO).text_size(XS).text_color(t.accent).child("Empfohlen")),
        );
    };
    return v_flex()
      .id(`q-${d.id}`)
      .flex_none()
      .rounded(12)
      .bg(isBlocking ? tint(tag.color, "1a") : t.raised)
      .child(
        v_flex()
          .gap(8)
          .px(14)
          .pt(14)
          .pb(answers.length ? 12 : 14)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(svg(ICON(tag.icon)).size(14).text_color(tag.color))
              .child(div().font_family(MONO).text_size(XS).font_semibold().text_color(tag.color).child(tag.label.toUpperCase()))
              .child(div().flex_1())
              .when(Boolean(d.at), (el) => el.child(this.meta(t.dim, ago(d.at)))),
          )
          .child(div().text_size(S).font_semibold().line_height(1.35).text_color(t.foreground).child(d.text))
          .when(Boolean(d.context), (el) => el.child(div().text_size(S).line_height(1.45).text_color(t.muted).child(d.context))),
      )
      .when(answers.length > 0, (el) => el.child(v_flex().gap(6).px(14).pb(14).children(answers.map(answer))))
      .when(Boolean(d.recommended) && !d.options?.includes(d.recommended), (el) =>
        el.child(div().px(14).pb(12).text_size(S).text_color(t.muted).child(`Empfehlung: ${d.recommended}`)),
      )
      .child(
        h_flex()
          .px(14)
          .py(8)
          .gap(16)
          .items_center()
          .bg(tint(tag.color, "14"))
          .child(this.quiet(t, `reply-${d.id}`, "Eigene Antwort", () => this.send({ do: "reply", id: d.id })))
          .child(this.quiet(t, `explain-${d.id}`, "Erklären", () => this.send({ do: "explain", id: d.id }))),
      );
  }

  todos(t, list) {
    const done = list.filter((x) => x.isDone).length;
    const share = list.length ? done / list.length : 0;
    const shown = this.view.hideDone ? list.filter((x) => !x.isDone) : list;
    const busy = t.working ?? t.ansi6;
    const row = (x) =>
      h_flex()
        .flex_none()
        .gap(10)
        .px(8)
        .py(5)
        .items_start()
        .rounded(8)
        .when(Boolean(x.isActive), (el) => el.bg(tint(busy, "1f")))
        .child(
          svg(ICON(x.isDone ? "erledigt" : x.isActive ? "aktiv" : "offen"))
            .mt(2)
            .size(16)
            .flex_none()
            .text_color(x.isDone ? t.dim : x.isActive ? busy : t.muted),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .text_size(S)
            .line_height(1.35)
            .text_color(x.isDone ? t.dim : t.foreground)
            .when(Boolean(x.isDone), (el) => el.line_through())
            .when(Boolean(x.isActive), (el) => el.font_medium())
            .child(x.text),
        )
        .when(Boolean(x.isActive && x.startedAt), (el) => el.child(div().mt(4).child(this.meta(busy, since(x.startedAt)))));
    return v_flex()
      .flex_none()
      .child(
        h_flex()
          .flex_none()
          .gap(10)
          .items_center()
          .mb(10)
          .child(div().flex_none().font_family(MONO).text_size(XS).font_semibold().text_color(t.foreground).child("TODOS"))
          .child(h_flex().flex_1().h(4).rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(t.ansi2).w(`${Math.round(share * 100)}%`)))
          .child(this.meta(t.muted, `${done}/${list.length}`)),
      )
      .child(v_flex().gap(2).children(shown.map(row)))
      .when(done > 0, (el) =>
        el.child(
          div()
            .pt(6)
            .px(8)
            .child(
              this.quiet(t, "todos-hide", this.view.hideDone ? `${done} erledigte einblenden` : "Erledigte ausblenden", (cx) => {
                this.setView("hideDone", !this.view.hideDone);
                cx.notify();
              }),
            ),
        ),
      );
  }

  // Plan files as a small tree: plan and version, its review and verify beneath; a click opens the file
  plans(t, list) {
    const row = (id, icon, name, right, path, isSub) =>
      h_flex()
        .id(id)
        .flex_none()
        .gap(10)
        .px(8)
        .py(5)
        .when(isSub, (el) => el.pl(34))
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => exec("open", [path]))
        .child(svg(ICON(icon)).size(isSub ? 14 : 16).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(S).text_color(t.foreground).child(name))
        .when(Boolean(right), (el) => el.child(this.meta(t.dim, right)));
    return v_flex()
      .flex_none()
      .gap(2)
      .children(
        list.flatMap((p) => {
          const base = p.path.replace(/\.md$/, "");
          const rows = [row(`plan-${p.path}`, "plan", `${p.name}.md`, p.version ? `v${p.version}` : "", p.path, false)];
          const review = p.files?.find((f) => f.path.endsWith(".review.md"));
          if (review?.exists) {
            const right = [p.latestReview && `#${p.latestReview}`, p.reviewedVersion && `gegen v${p.reviewedVersion}`].filter(Boolean).join(" · ");
            rows.push(row(`review-${p.path}`, "review", "review.md", right, `${base}.review.md`, true));
          }
          const verify = p.files?.find((f) => f.path.endsWith(".verify.md"));
          if (verify?.exists) {
            const right = [p.verify?.version && `v${p.verify.version}`, p.verify?.result].filter(Boolean).join(" · ");
            rows.push(row(`verify-${p.path}`, "verify", "verify.md", right, `${base}.verify.md`, true));
          }
          return rows;
        }),
      );
  }

  artifact(t, a) {
    return h_flex()
      .id(`art-${a.href}`)
      .flex_none()
      .px(6)
      .py(6)
      .gap(12)
      .items_center()
      .rounded(10)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("open", [a.href]))
      .child(div().size(32).flex_none().flex().items_center().justify_center().rounded(9).bg(t.raised).text_color(t.muted).child(svg(ICON(kindOf(a.href))).size(18)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().truncate().text_size(S).line_height(1.2).text_color(t.foreground).child(a.label))
          .child(div().truncate().font_family(MONO).text_size(XS).line_height(1.2).text_color(t.dim).child(hostOf(a.href))),
      )
      .when(Boolean(a.at), (el) => el.child(this.meta(t.dim, ago(a.at))));
  }

  // Griffe: one look for all; a click puts the prompt in the box, the × on hover removes it
  griffe(t, list) {
    const chip = (g, i) => {
      const key = `griff-${i}`;
      const isHot = this.hover === key;
      return h_flex()
        .id(key)
        .flex_none()
        .px(11)
        .py(5)
        .gap(6)
        .items_center()
        .rounded(9)
        .bg(t.background)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(g.text)
        .on_hover((h, cx) => {
          this.hover = h ? key : this.hover === key ? null : this.hover;
          cx.notify();
        })
        .on_click(() => this.send({ do: "griff.put", index: i }))
        .child(div().text_size(S).text_color(t.foreground).child(g.label))
        .when(isHot, (el) =>
          el.child(
            div()
              .id(`${key}-x`)
              .text_size(S)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.send({ do: "griff.remove", index: i });
              })
              .child("×"),
          ),
        );
    };
    const add = this.isAdding
      ? h_flex()
          .flex_none()
          .w_full()
          .h(34)
          .px(10)
          .rounded(9)
          .bg(t.background)
          .items_center()
          .child(Input.new(this.input).flex_1().h_full().text_size(S).text_color(t.foreground))
      : h_flex()
          .id("griff-add")
          .flex_none()
          .px(11)
          .py(5)
          .rounded(9)
          .cursor_pointer()
          .text_size(S)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            this.isAdding = true;
            this.input.focus();
            cx.notify();
          })
          .child("+ Griff hinzufügen");
    return h_flex().flex_none().flex_wrap().gap(6).children(list.map(chip)).child(add);
  }

  // Who held the ball when, over the last two hours, and the figures that follow from it
  session(t, b) {
    const now = Date.now();
    const segs = ballSegments(this.timeline[this.terminal] ?? [], now);
    if (segs.length === 0) return null;
    const total = segs.reduce((s, x) => s + (x.to - x.from), 0) || 1;
    const sum = (k) => segs.filter((x) => x.k === k).reduce((s, x) => s + (x.to - x.from), 0);
    const pc = (k) => `${Math.round((sum(k) / total) * 100)} %`;
    const longest = Math.max(0, ...segs.filter((x) => x.k === "C").map((x) => x.to - x.from));
    const waits = (b.log ?? []).filter((x) => x.openedAt && x.at >= now - WINDOW_MS).map((x) => x.at - x.openedAt);
    const avgWait = waits.length ? waits.reduce((s, x) => s + x, 0) / waits.length : null;
    const topics = (b.trail ?? []).filter((x) => x.at >= now - WINDOW_MS).length + (b.topic ? 1 : 0);
    const color = { C: t.working ?? t.ansi6, D: t.blocked ?? t.ansi1, R: t.border };
    const start = segs[0].from;
    // One line of shares that doubles as the legend, one line of the rest
    const share = (c, name, k) => h_flex().gap(5).items_center().child(div().size(6).rounded(3).bg(c)).child(this.meta(t.muted, `${name} ${pc(k)}`));
    const rest = [`längster Block ${span(longest)}`, avgWait !== null && `Frage offen Ø ${span(avgWait)}`, `${topics} ${topics === 1 ? "Thema" : "Themen"}`]
      .filter(Boolean)
      .join(" · ");
    return v_flex()
      .flex_none()
      .gap(8)
      .child(this.label(t, "Session", this.meta(t.muted, span(now - start))))
      .child(
        h_flex()
          .flex_none()
          .h(6)
          .gap(1)
          .children(segs.map((x) => div().h_full().rounded(2).bg(color[x.k]).w(`${((x.to - x.from) / total) * 100}%`))),
      )
      .child(h_flex().gap(14).flex_wrap().child(share(color.C, "Claude", "C")).child(share(color.D, "du", "D")).child(share(t.dim, "Pause", "R")))
      .child(this.meta(t.dim, rest));
  }

  // ── the view ────────────────────────────────────────────────────────────────

  render(cx) {
    const t = theme();
    // A new focus: look whether that terminal has a board (render stays synchronous)
    const now = focused()?.terminal ?? null;
    if (now !== this.tried) cx.spawn(async (cx) => this.follow(cx));

    const b = this.board;
    const agent = agents().find((a) => a.address === this.terminal);
    const canvas = t.canvas ?? t.background;

    if (!b) {
      const isClaude = agent?.app === "claude-code" || agent?.program?.key === "claude";
      const [title, text] = !this.terminal
        ? ["Noch kein Fokusboard", "Klick in einen Tab mit Claude Code."]
        : isClaude
          ? ["Noch kein Fokusboard", "Es erscheint, sobald Claude ein Thema setzt. Läuft die Session schon länger, starte sie neu."]
          : ["Kein Claude Code in diesem Tab", "Das Fokusboard gehört zu einer Claude-Code-Session."];
      return v_flex()
        .size_full()
        .bg(canvas)
        .items_center()
        .justify_center()
        .gap(10)
        .p(24)
        .child(svg(ICON("jetzt")).size(26).text_color(t.dim))
        .child(div().text_size(S).font_medium().text_color(t.foreground).child(title))
        .child(div().text_size(S).line_height(1.45).text_color(t.dim).text_center().child(text));
    }

    const decisions = b.decisions ?? [];
    const order = { blocking: 0, important: 1, optional: 2 };
    const questions = [...decisions].sort((x, y) => order[x.weight ?? "important"] - order[y.weight ?? "important"]);
    const links = [...(b.artifacts ?? []), ...this.published.filter((p) => !(b.artifacts ?? []).some((a) => a.href === p.href))];
    const todos = b.todos ?? [];
    const plans = b.plans ?? [];
    const griffe = b.griffe ?? [];
    const session = this.session(t, b);

    const body = v_flex()
      .id("fokus-body")
      .flex_1()
      .min_h(0)
      .px(16)
      .pb(26)
      .overflow_y_scrollbar()
      .when(Boolean(b.ended), (el) => el.opacity(0.6))
      .when(Boolean(b.thread || b.topic), (el) => el.child(this.head(t, b)))
      .when(Boolean(b.ended), (el) => el.child(div().pt(6).child(this.meta(t.dim, "Session beendet"))))
      .when(Boolean(b.topic), (el) => el.child(this.now(t, b.topic)))
      .when(!b.topic, (el) => el.child(div().pt(20).text_size(S).text_color(t.dim).child("Noch kein Thema. Claude setzt es, sobald das Gespräch eins hat.")))
      .when(questions.length > 0, (el) =>
        el.child(
          this.section(
            v_flex()
              .gap(8)
              .child(this.label(t, "Fragen", questions.length > 1 ? this.quiet(t, "ask-all", "alle beantworten →", () => this.send({ do: "ask" })) : null))
              .children(questions.map((d) => this.question(t, d))),
          ),
        ),
      )
      .when(todos.length > 0, (el) => el.child(this.section(this.todos(t, todos))))
      .when(plans.length > 0, (el) => el.child(this.section(v_flex().child(this.label(t, "Pläne")).child(this.plans(t, plans)))))
      .when(links.length > 0, (el) =>
        el.child(this.section(v_flex().child(this.label(t, "Artefakte")).child(v_flex().gap(2).children(links.map((a) => this.artifact(t, a)))))),
      )
;

    // Griffe and the session stay at the bottom while the board above scrolls; as one card
    const foot = v_flex()
      .flex_none()
      .mx(10)
      .mb(10)
      .px(14)
      .pt(14)
      .pb(14)
      .gap(18)
      .rounded(14)
      .bg(t.raised)
      .when(Boolean(b.ended), (el) => el.opacity(0.6))
      .child(v_flex().child(this.label(t, "Griffe")).child(this.griffe(t, griffe)))
      .when(Boolean(session), (el) => el.child(session));

    return v_flex().size_full().min_h(0).bg(canvas).text_color(t.foreground).child(body).child(foot);
  }
}
