// Fokus: the Fokusboard of the Claude Code session in the focused terminal, as the third tab of
// the right panel (layouts/main-filetree.json, stack "panel-body", child "fokus").
//
//   fokusboard mod (Claude Code) ──writes──► ~/.local/state/fokusboard/<terminal>.json ──watch──► here
//   here ──appends {at, do, …}──► ~/.local/state/fokusboard/<terminal>.inbox.jsonl ──► fokusboard mod
//
// The Claude Code mod owns the board and carries out every click (fill the prompt box, ask,
// explain …), so this view only draws and sends intents. It shows topic, questions, todos,
// artifacts and decisions (the plan workflow and the notes stay in the terminal pane). A terminal
// without a board keeps the last one shown. Artifacts merge the board's links with this session's publishes from the herdr
// plugin's hook (~/.local/state/herdr-artifacts/artifacts.jsonl).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, focused, home, readTextFile, theme, watchFolder, writeTextFile } from "herdr";

const DIR = `${home()}/.local/state/fokusboard`;
const ARTIFACTS = `${home()}/.local/state/herdr-artifacts/artifacts.jsonl`;
const ICON = (name) => `mods/fokus/${name}.svg`;
// The Claude accent the terminal board uses
const CLAUDE = "#D97757";
const KEEP_INTENTS = 30;

const STATUS_WORD = { working: "arbeitet", blocked: "wartet auf dich", done: "fertig", idle: "bereit" };

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "gerade eben";
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
}

// A #rrggbb color with alpha (two hex digits), for tinted cards; other values stay as they are
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

export default class Fokus extends View {
  init(_props, cx) {
    this.terminal = null; // the terminal whose board is shown
    this.tried = null; // the focused terminal last looked at
    this.board = null;
    this.published = [];
    this.hover = null;
    this.open = readJson(localStorage.getItem("open") ?? "") ?? { log: false, done: false, thread: true };
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
    // "vor 2 min" and the agent's status move on without a write
    cx.timer.every(15000, (cx) => cx.notify());
  }

  // Shows the focused terminal's board when it has one (also one that appeared since), else
  // reloads the board already shown
  async follow(cx) {
    const t = focused()?.terminal ?? null;
    this.tried = t;
    if (t && t !== this.terminal) {
      const text = await readTextFile(`${DIR}/${t}.json`).catch(() => null);
      const board = text && readJson(text);
      if (board) {
        this.terminal = t;
        this.board = board;
        this.published = await hookArtifacts(t);
        return cx.notify();
      }
    }
    await this.load(cx);
  }

  async load(cx) {
    if (!this.terminal) return;
    const text = await readTextFile(`${DIR}/${this.terminal}.json`).catch(() => null);
    this.board = (text && readJson(text)) ?? this.board;
    this.published = await hookArtifacts(this.terminal);
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

  toggle(key) {
    this.open = { ...this.open, [key]: !this.open[key] };
    localStorage.setItem("open", JSON.stringify(this.open));
  }

  // ── pieces ──────────────────────────────────────────────────────────────────

  header(t, label, count, opts = {}) {
    return h_flex()
      .flex_none()
      .pt(16)
      .pb(6)
      .gap(6)
      .items_center()
      .text_size(11)
      .font_semibold()
      .text_color(t.muted)
      .when(Boolean(opts.icon), (el) => el.child(svg(ICON(opts.icon)).size(12).text_color(opts.color ?? t.dim)))
      .child(div().child(label.toUpperCase()))
      .when(Boolean(count), (el) => el.child(div().font_normal().text_color(opts.color ?? t.dim).child(count)))
      .child(div().flex_1())
      .when(Boolean(opts.action), (el) => el.child(opts.action));
  }

  // A small text button; `solid` draws it filled
  button(t, id, label, onClick, opts = {}) {
    return h_flex()
      .id(id)
      .h(24)
      .px(9)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(12)
      .cursor_pointer()
      .when(Boolean(opts.solid), (el) => el.bg(opts.color ?? t.accent).text_color(t.solid_foreground ?? t.background).font_medium())
      .when(!opts.solid, (el) =>
        el
          .when(!opts.quiet, (el) => el.bg(t.raised))
          .text_color(opts.quiet ? t.dim : t.foreground)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)),
      )
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick();
      })
      .when(Boolean(opts.icon), (el) => el.child(svg(ICON(opts.icon)).size(12)))
      .child(label);
  }

  link(t, id, label, onClick, isThere = true) {
    if (!isThere) return div().text_color(t.dim).child(label);
    return div()
      .id(id)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.accent))
      .on_click(() => onClick())
      .child(label);
  }

  card(t, id, color) {
    return v_flex()
      .id(id)
      .flex_none()
      .gap(6)
      .p(12)
      .rounded(10)
      .bg(t.raised)
      .when(Boolean(color), (el) => el.border_l(3).border_color(color));
  }

  notice(t, n) {
    const color = n.kind === "verified" ? t.ansi2 : n.kind === "gaps" ? t.blocked ?? t.ansi1 : t.ansi3;
    return this.card(t, `notice-${n.kind}-${n.path}`, color)
      .bg(tint(color, "18"))
      .child(h_flex().gap(8).items_center().child(svg(ICON("flag")).size(14).text_color(color)).child(div().flex_1().font_medium().child(n.label)))
      .child(
        h_flex()
          .gap(6)
          .when(n.kind === "review", (el) => el.child(this.button(t, `act-${n.path}`, "Einarbeiten", () => this.send({ do: "notice.act", path: n.path, kind: n.kind }), { solid: true, color })))
          .when(n.kind === "gaps", (el) => el.child(this.button(t, `act-${n.path}`, "Nachbessern", () => this.send({ do: "notice.act", path: n.path, kind: n.kind }), { solid: true, color })))
          .child(this.button(t, `hide-${n.kind}-${n.path}`, "ausblenden", () => this.send({ do: "notice.dismiss", path: n.path, kind: n.kind }), { quiet: true })),
      );
  }

  thread(t, th) {
    const isOpen = this.open.thread !== false;
    return v_flex()
      .id("thread")
      .flex_none()
      .gap(4)
      .pt(14)
      .cursor_pointer()
      .on_click((_e, cx) => {
        this.toggle("thread");
        cx.notify();
      })
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(11)
          .font_semibold()
          .text_color(t.muted)
          .child("WORUM ES GEHT")
          .child(div().flex_1())
          .child(svg(ICON(isOpen ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim)),
      )
      .child(div().text_size(14).font_semibold().text_color(CLAUDE).child(th.title))
      .when(isOpen, (el) => el.child(div().text_size(12.5).line_height(1.4).text_color(t.muted).child(th.goal)));
  }

  topic(t, tp) {
    return v_flex()
      .flex_none()
      .mt(12)
      .gap(8)
      .p(14)
      .rounded(12)
      .bg(tint(CLAUDE, "14"))
      .border_1()
      .border_color(tint(CLAUDE, "44"))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(svg(ICON("focus")).size(15).text_color(CLAUDE))
          .child(div().text_size(10.5).font_semibold().text_color(CLAUDE).child("JETZT")),
      )
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(tp.title))
      .child(div().text_size(13).line_height(1.4).text_color(t.foreground).child(tp.summary))
      .when(tp.points?.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .pt(2)
            .children(
              tp.points.map((p) =>
                h_flex()
                  .gap(8)
                  .items_start()
                  .child(div().mt(6).size(5).flex_none().rounded(3).bg(CLAUDE))
                  .child(div().flex_1().text_size(12).line_height(1.4).text_color(t.muted).child(p)),
              ),
            ),
        ),
      );
  }

  // One open question: weight as a tag, the question and its context, the options as a list
  // (a click puts the answer in the prompt box), and a quiet toolbar for everything else
  question(t, d) {
    const weight = d.weight ?? "important";
    const tag = {
      blocking: { label: "Blockiert", color: t.blocked ?? t.ansi1 },
      important: { label: "Wichtig", color: t.ansi3 },
      optional: { label: "Optional", color: t.dim },
    }[weight];
    const options = [...(d.options ?? [])].sort((a, b) => (b === d.recommended) - (a === d.recommended));
    const option = (o, i) => {
      const isRec = o === d.recommended;
      const key = `opt-${d.id}-${i}`;
      const hot = this.hover === key;
      return h_flex()
        .id(key)
        .min_h(34)
        .px(11)
        .py(7)
        .gap(8)
        .items_center()
        .cursor_pointer()
        .when(i > 0, (el) => el.border_t(1).border_color(t.border))
        .when(isRec, (el) => el.bg(tint(CLAUDE, "1a")))
        .hover((s) => s.bg(isRec ? tint(CLAUDE, "2c") : t.hover))
        .on_hover((h, cx) => {
          this.hover = h ? key : this.hover === key ? null : this.hover;
          cx.notify();
        })
        .on_click(() => this.send({ do: "answer", id: d.id, option: o }))
        .child(div().flex_1().text_size(12.5).text_color(t.foreground).when(isRec, (el) => el.font_medium()).child(o))
        .when(isRec, (el) =>
          el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).bg(tint(CLAUDE, "33")).text_size(10.5).font_semibold().text_color(CLAUDE).child("Empfohlen")),
        )
        .child(div().flex_none().w(14).text_size(12).text_color(hot ? t.foreground : t.dim).child(hot ? "↵" : ""));
    };
    const tool = (id, label, icon, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(7)
        .gap(5)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(11.5)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => onClick())
        .child(svg(ICON(icon)).size(12))
        .when(Boolean(label), (el) => el.child(label));
    return v_flex()
      .id(`q-${d.id}`)
      .flex_none()
      .rounded(10)
      .bg(t.raised)
      .child(
        v_flex()
          .gap(6)
          .px(12)
          .pt(11)
          .pb(12)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().size(6).rounded(3).bg(tag.color))
              .child(div().text_size(10.5).font_semibold().text_color(tag.color).child(tag.label.toUpperCase())),
          )
          .child(div().text_size(13.5).font_medium().line_height(1.4).text_color(t.foreground).child(d.text))
          .when(Boolean(d.context), (el) => el.child(div().text_size(12).line_height(1.45).text_color(t.muted).child(d.context)))
          .when(options.length > 0, (el) =>
            el.child(v_flex().mt(4).rounded(8).border_1().border_color(t.border).overflow_hidden().children(options.map(option))),
          )
          .when(Boolean(d.recommended) && !d.options?.includes(d.recommended), (el) =>
            el.child(div().text_size(12).text_color(t.muted).child(`Empfehlung: ${d.recommended}`)),
          ),
      )
      .child(
        h_flex()
          .px(6)
          .py(4)
          .gap(2)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(tool(`reply-${d.id}`, "Antworten", "reply", () => this.send({ do: "reply", id: d.id })))
          .child(tool(`explain-${d.id}`, "Erklären", "sparkles", () => this.send({ do: "explain", id: d.id })))
          .child(tool(`ask-${d.id}`, "Fragen", "help", () => this.send({ do: "ask", ids: [d.id] })))
          .child(div().flex_1())
          .child(tool(`drop-${d.id}`, "", "x", () => this.send({ do: "dismiss", id: d.id }))),
      );
  }

  artifact(t, a) {
    return h_flex()
      .id(`art-${a.href}`)
      .flex_none()
      .h(34)
      .px(8)
      .gap(10)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("open", [a.href]))
      .child(div().size(24).flex_none().flex().items_center().justify_center().rounded(6).bg(tint(CLAUDE, "22")).text_color(CLAUDE).child(svg(ICON("page")).size(13)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(a.label))
      .when(Boolean(a.at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(a.at))));
  }

  todos(t, list) {
    const done = list.filter((x) => x.isDone);
    const open = list.filter((x) => !x.isDone);
    const share = list.length ? done.length / list.length : 0;
    const green = t.ansi2;
    return v_flex()
      .flex_none()
      .gap(4)
      .child(
        h_flex()
          .h(6)
          .mb(6)
          .rounded(3)
          .bg(t.border)
          .child(div().h_full().rounded(3).bg(green).w(`${Math.round(share * 100)}%`)),
      )
      .children(
        open.map((x) =>
          h_flex()
            .flex_none()
            .gap(9)
            .px(8)
            .py(5)
            .items_start()
            .rounded(7)
            .when(Boolean(x.isActive), (el) => el.bg(tint(CLAUDE, "1c")))
            .child(
              div()
                .mt(2)
                .flex_none()
                .when(Boolean(x.isActive), (el) => el.size(12).rounded(6).border_2().border_color(CLAUDE))
                .when(!x.isActive, (el) => el.child(svg(ICON("circle")).size(12).text_color(t.dim))),
            )
            .child(
              div()
                .flex_1()
                .text_size(12.5)
                .line_height(1.4)
                .text_color(x.isActive ? t.foreground : t.muted)
                .when(Boolean(x.isActive), (el) => el.font_medium())
                .child(x.text),
            ),
        ),
      )
      .when(done.length > 0, (el) =>
        el.child(
          h_flex()
            .id("todos-done")
            .gap(8)
            .px(8)
            .py(4)
            .items_center()
            .text_size(12)
            .text_color(green)
            .cursor_pointer()
            .on_click((_e, cx) => {
              this.toggle("done");
              cx.notify();
            })
            .child(svg(ICON("check")).size(12))
            .child(`${done.length} erledigt`)
            .child(div().flex_1())
            .child(this.button(t, "todos-clear", "entfernen", () => this.send({ do: "todos.clearDone" }), { quiet: true })),
        ),
      )
      .when(Boolean(this.open.done), (el) =>
        el.children(done.map((x) => div().px(8).pl(29).text_size(12).text_color(t.dim).line_through().child(x.text))),
      );
  }

  logEntry(t, x) {
    const green = t.ansi2;
    return h_flex()
      .flex_none()
      .gap(10)
      .items_start()
      .child(v_flex().items_center().pt(3).child(div().size(7).rounded(4).bg(green)))
      .child(
        v_flex()
          .flex_1()
          .gap(2)
          .pb(8)
          .child(div().text_size(12).line_height(1.4).text_color(t.muted).child(x.text))
          .child(
            h_flex()
              .gap(6)
              .text_size(12.5)
              .child(div().flex_1().font_medium().text_color(t.foreground).child(x.answer || "beantwortet"))
              .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(x.at))),
          ),
      );
  }

  // ── the view ────────────────────────────────────────────────────────────────

  render(cx) {
    const t = theme();
    // A new focus: look whether that terminal has a board (render stays synchronous)
    const now = focused()?.terminal ?? null;
    if (now !== this.tried) cx.spawn(async (cx) => this.follow(cx));

    const b = this.board;
    const agent = agents().find((a) => a.address === this.terminal);
    const status = b?.ended ? null : agent?.status ?? null;
    const statusColor = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[status] ?? t.dim;

    const head = h_flex()
      .flex_none()
      .h(44)
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg(ICON("focus")).size(16).text_color(CLAUDE))
      .child(div().text_size(13.5).font_semibold().child("Fokus"))
      .child(div().flex_1())
      .when(Boolean(this.terminal), (el) =>
        el.child(
          h_flex()
            .gap(6)
            .px(8)
            .h(22)
            .items_center()
            .rounded(11)
            .bg(t.raised)
            .text_size(11.5)
            .text_color(t.muted)
            .child(div().size(7).rounded(4).bg(b?.ended ? t.dim : statusColor))
            .child(div().max_w(150).truncate().child(agent?.tab_name || this.terminal))
            .child(div().text_color(t.dim).child(b?.ended ? "beendet" : STATUS_WORD[status] ?? "")),
        ),
      );

    if (!b) {
      return v_flex()
        .size_full()
        .bg(t.canvas ?? t.background)
        .child(head)
        .child(
          v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap(10)
            .p(24)
            .child(svg(ICON("focus")).size(28).text_color(tint(CLAUDE, "88")))
            .child(div().text_size(13).font_medium().child("Noch kein Fokusboard"))
            .child(
              div()
                .text_size(12)
                .line_height(1.4)
                .text_color(t.dim)
                .text_center()
                .child("Klick in ein Terminal mit Claude Code. Das Board erscheint, sobald die Session eins hat."),
            ),
        );
    }

    const decisions = b.decisions ?? [];
    const order = { blocking: 0, important: 1, optional: 2 };
    const questions = [...decisions].sort((x, y) => order[x.weight ?? "important"] - order[y.weight ?? "important"]);
    const blocking = decisions.filter((d) => d.weight === "blocking").length;
    const links = [...(b.artifacts ?? []).map((a) => ({ ...a })), ...this.published.filter((p) => !(b.artifacts ?? []).some((a) => a.href === p.href))];
    const log = b.log ?? [];
    const shownLog = this.open.log ? [...log].reverse() : log.slice(-1);
    const todos = b.todos ?? [];

    const body = v_flex()
      .id("fokus-body")
      .flex_1()
      .min_h(0)
      .px(14)
      .pb(20)
      .gap(8)
      .overflow_y_scrollbar()
      .when(b.ended, (el) => el.opacity(0.6))
      .when((b.notices ?? []).length > 0, (el) => el.child(v_flex().pt(12).gap(8).children(b.notices.map((n) => this.notice(t, n)))))
      .when(Boolean(b.thread), (el) => el.child(this.thread(t, b.thread)))
      .when(Boolean(b.topic), (el) => el.child(this.topic(t, b.topic)))
      .when(!b.thread && !b.topic, (el) => el.child(div().pt(14).text_size(12.5).text_color(t.dim).child("Noch kein Thema. Claude setzt es, sobald das Gespräch eins hat.")))
      .when(questions.length > 0, (el) =>
        el
          .child(
            this.header(t, "Offene Fragen", blocking ? `${questions.length} · ${blocking} blockiert` : String(questions.length), {
              icon: "help",
              color: blocking ? t.blocked : t.ansi3,
              action: questions.length > 1 ? this.button(t, "ask-all", "Alle stellen", () => this.send({ do: "ask" }), { quiet: true }) : null,
            }),
          )
          .children(questions.map((d) => this.question(t, d))),
      )
      .when(todos.length > 0, (el) =>
        el
          .child(this.header(t, "Todos", `${todos.filter((x) => x.isDone).length}/${todos.length}`, { icon: "check" }))
          .child(this.todos(t, todos)),
      )
      .when(links.length > 0, (el) =>
        el.child(this.header(t, "Artefakte", String(links.length), { icon: "page" })).child(v_flex().gap(1).children(links.map((a) => this.artifact(t, a)))),
      )
      .when(log.length > 0, (el) =>
        el
          .child(
            this.header(t, "Entschieden", String(log.length), {
              icon: "circle-check",
              color: t.ansi2,
              action:
                log.length > 1
                  ? this.button(t, "log-toggle", this.open.log ? "weniger" : `alle ${log.length}`, () => this.toggle("log"), { quiet: true })
                  : null,
            }),
          )
          .child(v_flex().children(shownLog.map((x) => this.logEntry(t, x)))),
      );

    const foot = h_flex()
      .flex_none()
      .h(28)
      .px(14)
      .gap(6)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(11)
      .text_color(t.dim)
      .child(div().child(this.terminal))
      .child(div().child("·"))
      .child(div().flex_1().truncate().child((b.cwd ?? "").split("/").pop() ?? ""))
      .child(div().child(b.updatedAt ? `aktualisiert ${ago(b.updatedAt)}` : ""));

    return v_flex().size_full().min_h(0).bg(t.canvas ?? t.background).text_color(t.foreground).child(head).child(body).child(foot);
  }
}
