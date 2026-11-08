// pane-icons: Marcus' copy of Herdr's pane header (Herdr replaces its own `pane` on start).
// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-icons" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// A Claude Code pane also shows its model · effort and context meter on the right, from
// ~/.local/state/herdr-session-bar/<terminal>.json (session-bar's Claude Code plugin);
// a click opens session-bar-icons' Claude card. The bottom bar no longer shows them.
// On the right, this pane's git: branch (click copies), ↑ ↓ (click: session-bar-icons' push /
// pull menu) and changed files (click: filetree's Changed view). Read again on a cd, when a
// turn or command ends, and when the repo's files change.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, theme, home, readTextFile, watchFolder, openOverlay, exec, notify, layout, setShared } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

// `git status --porcelain=v1 -z -b` → branch, upstream, ahead / behind, changed files.
function parseStatus(stdout) {
  const g = { branch: null, upstream: "", ahead: 0, behind: 0, changed: 0, untracked: 0 };
  for (const rec of stdout.split("\0")) {
    if (rec.startsWith("## ")) {
      const body = rec.slice(3);
      g.branch = body.startsWith("HEAD (no branch)") ? "detached" : body.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/)?.[1] ?? body;
      g.upstream = body.match(/\.\.\.(\S+)/)?.[1] ?? "";
      g.ahead = Number(body.match(/ahead (\d+)/)?.[1] ?? 0);
      g.behind = Number(body.match(/behind (\d+)/)?.[1] ?? 0);
      continue;
    }
    if (rec.length < 4) continue;
    g.changed++;
    if (rec.startsWith("??")) g.untracked++;
  }
  return g;
}

// Shows the layout block with `mod`: selects it in every stack on the way. False: no such block.
function revealMod(mod) {
  const path = [];
  const walk = (n) => {
    if (!n) return false;
    path.push(n);
    if (n.content?.mod === mod) return true;
    for (const c of n.children ?? []) if (walk(c)) return true;
    path.pop();
    return false;
  };
  let found = false;
  try { found = walk(layout()); } catch {}
  if (!found) return false;
  path.forEach((n, i) => {
    if (n.type === "stack" && path[i + 1]?.id) run("layout.select", { stack: n.id, child: path[i + 1].id });
    if (i > 0 && n.id) run("layout.show", { id: n.id });
  });
  return true;
}

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

  // This pane's repo, one look at a time; `again` when asked meanwhile.
  readGit(cx) {
    const p = this.me();
    const cwd = p?.cwd;
    const on = spaces().find((s) => (s.tabs ?? []).some((c) => c.id === p?.tab))?.machine ?? null;
    if (!cwd) { this.git = null; return; }
    if (this.loading) { this.again = true; return; }
    const key = JSON.stringify([cwd, on]);
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const g = (args) => exec("git", [...READ, ...args], { cwd, on });
        const top = await g(["rev-parse", "--show-toplevel"]).catch(() => null);
        if (top?.code !== 0) { if (this.gitKey === key) this.git = null; return; }
        const status = await g(["status", "--porcelain=v1", "-z", "-b", "--untracked-files=normal"]);
        if (this.gitKey !== key || status.code !== 0) return;
        this.git = { ...parseStatus(status.stdout), top: top.stdout.trim(), cwd, on };
        this.watchRepo(this.git.top, on, cx);
      } catch { if (this.gitKey === key) this.git = null; }
      finally {
        this.loading = false;
        if (this.again) { this.again = false; this.readGit(cx); }
        cx.notify();
      }
    });
  }

  watchRepo(top, on, cx) {
    if (on || this.watched === top) return;
    this.watched = top;
    cx.spawn(async (cx) => {
      try { while (this.watched === top) { await watchFolder(top); if (this.watched === top) this.readGit(cx); } }
      catch { if (this.watched === top) this.watched = null; }
    });
  }

  // Branch, ↑ ↓ and changed files, small and quiet like the folder.
  gitChips(t, pane) {
    const g = this.git;
    if (!g?.branch) return [];
    const chip = (id, icon, color, tip, label, onClick) => h_flex().id(`${id}-${pane}`).flex_none().h(20).px(5).gap(4).items_center().rounded(5)
      .text_size(11.5).text_color(color).tooltip(tip).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`mods/pane-icons/${icon}.svg`).size(11).flex_none().text_color(color))
      .child(div().max_w(160).truncate().child(label));
    const gitMenu = () => openOverlay({ mod: "session-bar-icons", kind: "popup", width: 280, height: (g.ahead && g.behind ? 3 : 2) * 44 + 10, props: { popup: { kind: "git", git: g, info: null, router: null } } });
    const changed = () => { setShared("filetree.view", { view: "changed", n: Date.now() }); if (!revealMod("filetree")) run("pane.split", { direction: "right", mod: "filetree" }); };
    return [
      chip("ph-branch", "git-branch", t.muted, g.upstream ? `Tracks ${g.upstream} · click to copy` : "Click to copy", g.branch,
        (cx) => { cx.write_to_clipboard(g.branch); notify({ title: "Copied", body: g.branch, timeout: 1500 }); }),
      g.ahead ? chip("ph-ahead", "arrow-up", t.ansi6, `${g.ahead} to push`, String(g.ahead), gitMenu) : null,
      g.behind ? chip("ph-behind", "arrow-down", t.ansi4, `${g.behind} to pull`, String(g.behind), gitMenu) : null,
      g.changed ? chip("ph-changed", "pencil", t.ansi11 ?? t.ansi3, `${g.changed} uncommitted (${g.untracked} untracked) · open Changed`, String(g.changed), changed) : null,
    ].filter(Boolean);
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
    // A cd, or a turn / command that just ended (a checkout, a commit): look at git again.
    const gitKey = JSON.stringify([p.cwd, p.tab]);
    if (gitKey !== this.gitAt) { this.gitKey = JSON.stringify([p.cwd, spaces().find((s) => (s.tabs ?? []).some((c) => c.id === p.tab))?.machine ?? null]); this.gitAt = gitKey; this.git = null; this.readGit(cx); }
    const busy = p.status === "working" || !(p.program?.shell || p.program?.agent);
    if (this.busy && !busy) this.readGit(cx);
    this.busy = busy;
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
      .children(this.gitChips(t, pane))
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
