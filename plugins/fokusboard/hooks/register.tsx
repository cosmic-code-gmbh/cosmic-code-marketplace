// Fokusboard: the current topic, the plan workflow, artifacts, open decisions and todos in a side pane.
// Board logic (todos, decisions, the Stop nudge) follows sirkitree/pinboard (MIT).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact, Decision, LogEntry, Notice, PlanStatus, Snapshot, Step, Thread, Todo, Topic } from '../types'

const PANE = 'fokusboard'
const TITLE = 'Fokusboard'
const TOOL = 'mcp__fokusboard__update'
const POLL_MS = 5000

const thread = atom({ plugin: 'fokusboard', key: 'thread' } as const, null as Thread | null)
const topic = atom({ plugin: 'fokusboard', key: 'topic' } as const, null as Topic | null)
const decisions = atom({ plugin: 'fokusboard', key: 'decisions' } as const, [] as Decision[])
const todos = atom({ plugin: 'fokusboard', key: 'todos' } as const, [] as Todo[])
const artifacts = atom({ plugin: 'fokusboard', key: 'artifacts' } as const, [] as Artifact[])
const mode = atom({ plugin: 'fokusboard', key: 'mode' } as const, null as string | null)
const plans = atom({ plugin: 'fokusboard', key: 'plans' } as const, [] as string[])
const planStatus = atom({ plugin: 'fokusboard', key: 'planStatus' } as const, [] as PlanStatus[])
const lastCodeEditAt = atom({ plugin: 'fokusboard', key: 'lastCodeEditAt' } as const, 0)
const log = atom({ plugin: 'fokusboard', key: 'log' } as const, [] as LogEntry[])
const showLog = atom({ plugin: 'fokusboard', key: 'showLog' } as const, false)
const notices = atom({ plugin: 'fokusboard', key: 'notices' } as const, [] as Notice[])
const offer = atom({ plugin: 'fokusboard', key: 'offer' } as const, null as Snapshot | null)

const DESCRIPTION = [
  "Keep the user's Fokusboard current: a sidebar that stays in view while the transcript scrolls, showing the current topic, the plan workflow, artifacts, open decisions and the task list.",
  'thread: what this whole conversation is about, the anchor the user reads first so every later step makes sense. Set it once, early: title 3-8 words, goal 1-3 sentences on the overall aim and why. It stays put while the work moves on; change it only when the overall goal changes fundamentally, and then give why (the board refuses a thread change without why). Never use it for the current step.',
  'topic: the current focus within the thread (what is being worked on right now); set it when a conversation gets a subject, and update it whenever the subject shifts or your understanding changes materially (a decision made, a cause found, a plan agreed).',
  'topic.title: 2-6 words. topic.summary: 1-3 short sentences on where things stand now, not a history. topic.points: up to 5 terse key facts or constraints worth keeping in view.',
  "Write the topic in the user's language.",
  'track_plans: paths of plan files (docs/**/<name>.md of the Plan → Review → Einarbeiten → Verify workflow) this session works on; the board reads their version headers and .review.md/.verify.md siblings itself. Plans you write, edit or exit plan mode with are tracked automatically. untrack_plans removes them.',
  'add_artifacts: links that matter for the current work ({label, href}): claude.ai artifacts, PRs, docs. remove_artifacts: by href.',
  'Any question you end a reply on that needs the user to answer goes in open_decisions, however small, even a single yes/no.',
  'Use todos in place of writing task lists in your reply whenever the work takes 3+ distinct steps.',
  'add_todos: one action per item. start_todo: the todo id you are working on now; exactly one at a time. done_todos / remove_todos: todo ids.',
  'Mark a todo done only after the work, including any verification, is actually done.',
  'decide: close a decision by id once the user has answered, with the answer in a few words (it stays in the decision log the user reads later). clear_done: drop finished todos when a new topic starts.',
  'The current board, with ids, is at the end of your system prompt.',
].join(' ')

const strings = { type: 'array', items: { type: 'string' } }
const SCHEMA = {
  type: 'object',
  properties: {
    thread: {
      type: 'object',
      properties: { title: { type: 'string' }, goal: { type: 'string' }, why: { type: 'string' } },
      required: ['title', 'goal'],
    },
    topic: {
      type: 'object',
      properties: { title: { type: 'string' }, summary: { type: 'string' }, points: strings },
      required: ['title', 'summary'],
    },
    track_plans: strings,
    untrack_plans: strings,
    add_artifacts: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, href: { type: 'string' } }, required: ['label', 'href'] },
    },
    remove_artifacts: strings,
    add_todos: strings,
    start_todo: { type: 'string' },
    done_todos: strings,
    remove_todos: strings,
    clear_done: { type: 'boolean' },
    open_decisions: strings,
    decide: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] },
    },
  },
}

export type Update = {
  thread?: { title: string; goal: string; why?: string }
  topic?: { title: string; summary: string; points?: string[] }
  track_plans?: string[]
  untrack_plans?: string[]
  add_artifacts?: Artifact[]
  remove_artifacts?: string[]
  add_todos?: string[]
  start_todo?: string
  done_todos?: string[]
  remove_todos?: string[]
  clear_done?: boolean
  open_decisions?: string[]
  decide?: { id: string; answer: string }[]
}

export type Board = { thread: Thread | null; topic: Topic | null; todos: Todo[]; decisions: Decision[]; artifacts: Artifact[]; log: LogEntry[] }

// The next id for a prefix: one past the highest in use
const nextId = (prefix: string, ids: string[]) =>
  prefix + (Math.max(0, ...ids.map(id => Number(id.slice(prefix.length)) || 0)) + 1)

export function applyUpdate(board: Board, change: Update, now = Date.now()): Board {
  let { thread: th, topic: tp, todos: t, decisions: d, artifacts: a, log: l } = board
  // The thread is the stable anchor: set once, replaced only with a reason
  if (change.thread && (!th || change.thread.why?.trim())) {
    th = { title: change.thread.title.trim(), goal: change.thread.goal.trim() }
  }
  if (change.topic) {
    tp = {
      title: change.topic.title.trim(),
      summary: change.topic.summary.trim(),
      points: (change.topic.points ?? []).map(p => p.trim()).filter(Boolean).slice(0, 5),
    }
  }
  const gone = new Set(change.remove_artifacts ?? [])
  a = a.filter(x => !gone.has(x.href))
  for (const x of change.add_artifacts ?? []) a = [...a.filter(y => y.href !== x.href), { label: x.label.trim(), href: x.href.trim() }]
  if (change.clear_done) t = t.filter(x => !x.isDone)
  for (const text of change.add_todos ?? []) t = [...t, { id: nextId('t', t.map(x => x.id)), text, isDone: false }]
  for (const text of change.open_decisions ?? []) d = [...d, { id: nextId('d', d.map(x => x.id)), text }]
  const done = new Set(change.done_todos ?? [])
  const removed = new Set(change.remove_todos ?? [])
  const decided = new Set((change.decide ?? []).map(x => x.id))
  t = t.filter(x => !removed.has(x.id)).map(x => (done.has(x.id) ? { ...x, isDone: true } : x))
  // One todo in progress at a time; finishing it ends its turn too
  if (change.start_todo) t = t.map(x => ({ ...x, isActive: x.id === change.start_todo }))
  t = t.map(x => (x.isDone && x.isActive ? { ...x, isActive: false } : x))
  // A decision closes into the log with its answer, so the why stays findable
  const answers = new Map((change.decide ?? []).map(x => [x.id, x.answer.trim()]))
  l = [...l, ...d.filter(x => decided.has(x.id)).map(x => ({ text: x.text, answer: answers.get(x.id) ?? '', at: now }))].slice(-30)
  d = d.filter(x => !decided.has(x.id))
  return { thread: th, topic: tp, todos: t, decisions: d, artifacts: a.slice(-12), log: l }
}

// ── Plan workflow ────────────────────────────────────────────────────────────

// <name>.review.md and <name>.verify.md belong to <name>.md
export const planOf = (path: string) => path.replace(/\.(review|verify)\.md$/, '.md')

const maxOf = (text: string, re: RegExp) => {
  const all = [...text.matchAll(re)].map(m => Number(m[1]))
  return all.length ? Math.max(...all) : null
}

// Reads the version headers docs/plan-workflow.md defines
export function parseHeaders(plan: string, review: string, verify: string) {
  const integrated = [...plan.matchAll(/Plan Version #(\d+)\s*[—–-]+\s*Review #(\d+) eingearbeitet/g)].map(m => Number(m[2]))
  const verdicts = [
    ...verify.matchAll(/Verifikation gegen Plan Version #(\d+)\s*[—–-]+\s*Ergebnis:?[\s*_`[]*(vollständig|Lücken|unvollständig)/gi),
  ]
  const last = verdicts.at(-1)
  const word = last?.[2]?.toLowerCase()
  const result: PlanStatus['verifyResult'] = word === 'lücken' ? 'Lücken' : word === 'vollständig' || word === 'unvollständig' ? word : null
  return {
    planVersion: maxOf(plan, /Plan Version #(\d+)/g),
    integratedReview: integrated.length ? Math.max(...integrated) : null,
    latestReview: maxOf(review, /Review Version #(\d+)/g),
    verifiedVersion: last ? Number(last[1]) : null,
    verifyResult: result,
  }
}

export type Stage = { step: Step; label: string; tone: 'ok' | 'wait' | 'warn' | 'busy' }

// Where a plan stands, from its headers alone (and whether code changed since the plan was settled)
export function stageOf(s: PlanStatus, lastCodeEdit: number): Stage {
  if (!s.exists) return { step: 'plan', label: 'Plan wird erstellt', tone: 'busy' }
  if (!s.hasReview || s.latestReview === null) return { step: 'review', label: 'wartet auf Review (Codex)', tone: 'wait' }
  if (s.latestReview > (s.integratedReview ?? 0)) return { step: 'integrate', label: `Review #${s.latestReview} einarbeiten`, tone: 'warn' }
  if (!s.hasVerify || s.verifiedVersion === null) {
    return lastCodeEdit > s.planMtime
      ? { step: 'implement', label: 'Umsetzung läuft', tone: 'busy' }
      : { step: 'implement', label: 'bereit zur Umsetzung', tone: 'wait' }
  }
  if (s.planVersion !== null && s.verifiedVersion < s.planVersion) {
    return { step: 'verify', label: `Verify veraltet (gegen v${s.verifiedVersion})`, tone: 'warn' }
  }
  if (s.verifyResult === 'vollständig') return { step: 'done', label: 'vollständig verifiziert', tone: 'ok' }
  return { step: 'verify', label: `Nachbessern: ${s.verifyResult ?? 'Ergebnis offen'}`, tone: 'warn' }
}

export const STEPS: { step: Step; label: string }[] = [
  { step: 'plan', label: 'Plan' },
  { step: 'review', label: 'Review' },
  { step: 'integrate', label: 'Einarb.' },
  { step: 'implement', label: 'Umsetz.' },
  { step: 'verify', label: 'Verify' },
]

const ORDER: Step[] = ['plan', 'review', 'integrate', 'implement', 'verify', 'done']

// The pipeline as glyphs: ● passed, ◉ current, ○ ahead
export const pipeline = (current: Step) =>
  STEPS.map(x => {
    const at = ORDER.indexOf(x.step)
    const now = ORDER.indexOf(current)
    return { ...x, state: at < now ? 'passed' : at === now ? 'current' : 'ahead' } as const
  })

const readOr = async ($: EngineInterface, path: string) => {
  try {
    return { text: String(await $.fs.read(path)), ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

const mtimeOf = async ($: EngineInterface, path: string) => {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function statusOf($: EngineInterface, path: string): Promise<PlanStatus> {
  const base = path.replace(/\.md$/, '')
  const [plan, review, verify] = [await readOr($, path), await readOr($, base + '.review.md'), await readOr($, base + '.verify.md')]
  return {
    path,
    name: base.split('/').at(-1) ?? base,
    exists: plan.ok,
    ...parseHeaders(plan.text, review.text, verify.text),
    hasReview: review.ok,
    hasVerify: verify.ok,
    planMtime: Math.max(await mtimeOf($, path), await mtimeOf($, base + '.review.md')),
  }
}

// Re-reads every tracked plan; writes only when something changed, so the pane redraws only then
async function refresh($: EngineInterface) {
  const paths = await read($, plans)
  const next: PlanStatus[] = []
  for (const p of paths) next.push(await statusOf($, p))
  const before = await read($, planStatus)
  if (JSON.stringify(before) === JSON.stringify(next)) return
  await update($, planStatus, () => next)
  const fresh = noticesFor(before, next, Date.now())
  const kept = (await read($, notices)).filter(n => stillDue(n, next))
  const all = [...kept.filter(n => !fresh.some(f => f.path === n.path && f.kind === n.kind)), ...fresh]
  if (JSON.stringify(all) !== JSON.stringify(await read($, notices))) await update($, notices, () => all)
  for (const n of fresh) {
    try {
      await $.ui.toast(`Fokusboard: ${n.label}`)
    } catch {}
  }
}

// What changed in a plan since the last read and asks for a step: a new review, a new verify result
export function noticesFor(before: PlanStatus[], after: PlanStatus[], now: number): Notice[] {
  const out: Notice[] = []
  for (const s of after) {
    const prev = before.find(b => b.path === s.path)
    // A plan seen for the first time is not news
    if (!prev) continue
    if ((s.latestReview ?? 0) > (prev.latestReview ?? 0)) {
      out.push({ path: s.path, name: s.name, kind: 'review', label: `Review #${s.latestReview} zu ${s.name} ist da`, at: now })
    }
    if (s.verifyResult && (s.verifyResult !== prev.verifyResult || s.verifiedVersion !== prev.verifiedVersion)) {
      out.push(
        s.verifyResult === 'vollständig'
          ? { path: s.path, name: s.name, kind: 'verified', label: `${s.name} ist vollständig verifiziert`, at: now }
          : { path: s.path, name: s.name, kind: 'gaps', label: `Verify zu ${s.name}: ${s.verifyResult}`, at: now },
      )
    }
  }
  return out
}

// A notice goes once its step is done: the review worked in, the gaps closed
export function stillDue(n: Notice, status: PlanStatus[]): boolean {
  const s = status.find(x => x.path === n.path)
  if (!s) return false
  if (n.kind === 'review') return (s.latestReview ?? 0) > (s.integratedReview ?? 0)
  if (n.kind === 'gaps') return s.verifyResult !== 'vollständig'
  return true
}

// A path the workflow knows: a Markdown file under docs/
const isDocsMd = (path: string) => /(^|\/)docs\/.+\.md$/.test(path)

async function absolute($: EngineInterface, path: string) {
  if (path.startsWith('/')) return path
  const cwd = await $.session.cwd()
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}

// Tracks a docs/ Markdown file when it is a plan of the workflow (or one of its review/verify files)
async function maybeTrack($: EngineInterface, raw: string, force = false) {
  if (!force && !isDocsMd(raw)) return false
  const path = planOf(await absolute($, raw))
  if ((await read($, plans)).includes(path)) return false
  if (!force) {
    const base = path.replace(/\.md$/, '')
    const text = (await readOr($, path)).text
    const isPlan = /Plan Version #\d+/.test(text) || (await $.fs.exists(base + '.review.md')) || raw !== path
    if (!isPlan) return false
  }
  await update($, plans, list => [...list, path].slice(-6))
  await save($)
  return true
}

// ── Board text for the system prompt ────────────────────────────────────────

export function describeBoard(board: Board, status: PlanStatus[] = [], currentMode: string | null = null, lastCodeEdit = 0): string {
  const lines = ['Fokusboard now:']
  lines.push(
    board.thread
      ? `Thread: ${board.thread.title}: ${board.thread.goal}`
      : 'Thread: (none yet; set thread with the overall goal of this conversation)',
  )
  if (board.topic) {
    lines.push(`Topic: ${board.topic.title}: ${board.topic.summary}`)
    lines.push(...board.topic.points.map(p => `  - ${p}`))
  } else {
    lines.push('Topic: (none yet; set it with topic once the conversation has a subject)')
  }
  if (currentMode === 'plan') lines.push('Mode: plan mode')
  lines.push(...status.map(s => `Plan ${s.path}: ${stageOf(s, lastCodeEdit).label}`))
  lines.push(...board.artifacts.map(a => `Artifact: ${a.label} <${a.href}>`))
  lines.push(...board.todos.map(t => `${t.id} [${t.isDone ? 'x' : t.isActive ? '>' : ' '}] ${t.text}`))
  lines.push(...board.decisions.map(d => `${d.id} [?] ${d.text}`))
  lines.push(...board.log.slice(-5).map(x => `Decided: ${x.text} → ${x.answer}`))
  return lines.join('\n')
}

// A reply asks the user something when one of its last lines, outside code, ends in a question mark
export function asksUser(reply: string): boolean {
  const prose = reply.replace(/```[\s\S]*?```/g, '')
  const lines = prose.split('\n').map(l => l.trim()).filter(Boolean).slice(-3)
  return lines.some(l => /\?[*_`)"'\]]*$/.test(l))
}

const NUDGE =
  'Your reply ends on a question for the user, but the Fokusboard has no open decision. ' +
  'Call mcp__fokusboard__update with open_decisions for it (close it with decide once answered), then end your turn. ' +
  'If it was rhetorical, end your turn as is.'

const readBoard = async ($: EngineInterface): Promise<Board> => ({
  log: await read($, log),
  thread: await read($, thread),
  topic: await read($, topic),
  todos: await read($, todos),
  decisions: await read($, decisions),
  artifacts: await read($, artifacts),
})

const isEmpty = (b: Board) => !b.thread && !b.topic && b.todos.length + b.decisions.length + b.artifacts.length === 0

export function summarize(change: Update): string {
  const parts = [
    change.thread && `thread "${change.thread.title}"`,
    change.topic && `topic "${change.topic.title}"`,
    change.track_plans?.length && `+${change.track_plans.length} plan`,
    change.untrack_plans?.length && `-${change.untrack_plans.length} plan`,
    change.add_artifacts?.length && `+${change.add_artifacts.length} artifact`,
    change.remove_artifacts?.length && `-${change.remove_artifacts.length} artifact`,
    change.add_todos?.length && `+${change.add_todos.length} todo`,
    change.start_todo && `started ${change.start_todo}`,
    change.done_todos?.length && `${change.done_todos.length} done`,
    change.remove_todos?.length && `-${change.remove_todos.length} todo`,
    change.clear_done && 'cleared done',
    change.open_decisions?.length && `+${change.open_decisions.length} decision`,
    change.decide?.length && `${change.decide.length} decided`,
  ].filter(Boolean)
  return 'Fokusboard: ' + (parts.join(', ') || 'no change')
}

// A focus target for the title of the topic card; the desktop draws SVG as an image, so the accent is a hex, not a theme key
const FOCUS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">' +
  '<circle cx="12" cy="12" r="8.75" stroke="#D97757" stroke-width="2.5"/>' +
  '<circle cx="12" cy="12" r="3.75" fill="#D97757"/></svg>'

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

// Puts "Zu „…“: " in the prompt box so the person types the answer right after it
async function replyTo($: EngineInterface, d: Decision) {
  const lead = `Zu „${d.text}“: `
  const { text } = await $.prompt.read()
  const { isFilled } = await $.prompt.fill(text.trim() ? { text: `\n${lead}`, mode: 'append' } : { text: lead, mode: 'replace' })
  // The desktop draws its own composer; there Claude asks instead
  if (!isFilled) await askAbout($, [d])
}

// Has Claude put the open questions to the person, one dialog with options each
async function askAbout($: EngineInterface, list: Decision[]) {
  if (list.length === 0) return
  const lines = list.map(d => `${d.id}: ${d.text}`).join('\n')
  await $.prompt.submit({
    text:
      `Stell mir ${list.length === 1 ? 'diese offene Frage' : 'diese offenen Fragen'} vom Fokusboard jetzt direkt ` +
      `mit AskUserQuestion, jeweils mit sinnvollen Antwortoptionen, und schließe sie danach mit decide:\n${lines}`,
  })
  await $.ui.toast(list.length === 1 ? 'Claude stellt dir die Frage gleich.' : `Claude stellt dir die ${list.length} Fragen gleich.`)
}

// Opens a plan file in the Mac's default app for Markdown
async function openFile($: EngineInterface, path: string) {
  const { exitCode, stderr } = await $.process.run(['open', path])
  if (exitCode !== 0) await $.ui.toast(`Konnte ${path.split('/').at(-1)} nicht öffnen: ${stderr.trim()}`)
}

// ── Persistence per repository and branch ───────────────────────────────────

// The store key of this checkout: its repository root and branch, or the folder outside git
async function storeKey($: EngineInterface): Promise<{ key: string; branch: string }> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (top.exitCode === 0 && head.exitCode === 0) {
      return { key: `board:${top.stdout.trim()}:${head.stdout.trim()}`, branch: head.stdout.trim() }
    }
  } catch {}
  return { key: `board:${await $.session.cwd().catch(() => 'unknown')}`, branch: '' }
}

// Saves the board for this branch; never an empty one, and not while an earlier one waits to be restored
async function save($: EngineInterface) {
  if (await read($, offer)) return
  const board = await readBoard($)
  const tracked = await read($, plans)
  if (isEmpty(board) && tracked.length === 0) return
  // Saving is a convenience: a store or git that fails never stops the board
  try {
    const { key, branch } = await storeKey($)
    const snap: Snapshot = { branch, savedAt: Date.now(), board, plans: tracked }
    await $.store.set(key, snap)
  } catch {}
}

async function restore($: EngineInterface, snap: Snapshot) {
  const b = snap.board
  await update($, thread, () => b.thread)
  await update($, topic, () => b.topic)
  await update($, todos, () => b.todos)
  await update($, decisions, () => b.decisions)
  await update($, artifacts, () => b.artifacts)
  await update($, log, () => b.log ?? [])
  await update($, plans, () => snap.plans)
  await update($, offer, () => null)
  await refresh($)
}

async function discard($: EngineInterface) {
  await update($, offer, () => null)
  await $.store.delete((await storeKey($)).key)
}

// "vor 2 h", "vor 3 Tagen"
export function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `vor ${h} h`
  const days = Math.round(h / 24)
  return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`
}

// Relative to the session folder, for commands the person reads
async function relative($: EngineInterface, path: string) {
  const cwd = (await $.session.cwd()).replace(/\/$/, '') + '/'
  return path.startsWith(cwd) ? path.slice(cwd.length) : path
}

// The step a notice asks for: the review command into the prompt box, or Claude asked to close the gaps
async function act($: EngineInterface, n: Notice) {
  const rel = await relative($, n.path)
  if (n.kind === 'review') {
    const command = `/plan-integrate-review ${rel}`
    const { text } = await $.prompt.read()
    const { isFilled } = text.trim() ? { isFilled: false } : await $.prompt.fill({ text: command, mode: 'replace' })
    if (!isFilled) await $.prompt.submit({ text: `Arbeite das neue Review zu ${rel} ein, wie ${command}.` })
  } else if (n.kind === 'gaps') {
    await $.prompt.submit({
      text: `Die Verifikation zu ${rel} meldet Lücken. Lies ${rel.replace(/\.md$/, '.verify.md')} und bessere die Punkte nach.`,
    })
  }
  await update($, notices, list => list.filter(x => x !== n && !(x.path === n.path && x.kind === n.kind)))
}

// The mode rides on every classic hook's input; keep the latest
const noteMode = async ($: EngineInterface, value: string | undefined) => {
  if (value && value !== (await read($, mode))) await update($, mode, () => value)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fokus', description: 'Open the Fokusboard: topic, plan workflow, decisions, todos', immediate: true })
    await $.tool.register({ name: 'update', description: DESCRIPTION, inputSchema: SCHEMA })
    // Codex writes .review.md and .verify.md outside this session; poll the tracked plans
    void $.clock.every(POLL_MS, async () => {
      if ((await read($, plans)).length > 0) await refresh($)
    })
    // An empty board with a saved one for this branch: offer to pick up where it stopped
    if (isEmpty(await readBoard($)) && !(await read($, offer))) {
      try {
        const { key } = await storeKey($)
        const snap = (await $.store.get(key)) as Snapshot | undefined
        if (snap && !isEmpty({ ...snap.board, log: snap.board.log ?? [] })) {
          await update($, offer, () => snap)
          void open($)
        }
      } catch {}
    }
    return next(e)
  })

  on('command.run', { command: 'fokus' }, async $ => {
    await refresh($)
    await open($)
    return {}
  })

  // The board rides at the end of the system prompt, so it never has to be repeated in replies
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const saved = await read($, offer)
    const text =
      describeBoard(await readBoard($), await read($, planStatus), await read($, mode), await read($, lastCodeEditAt)) +
      (saved
        ? `\nA board saved for branch ${saved.branch || 'this folder'} (${saved.board.thread?.title ?? saved.board.topic?.title ?? 'untitled'}) waits in the pane; the user restores it with Weitermachen.`
        : '')
    return { sections: [...sections, { id: 'fokusboard:board', text, scope: 'session' }] }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    // A plan path in the prompt (/plan-integrate-review docs/…/x.md) joins the board
    let added = false
    for (const m of (e.prompt ?? '').matchAll(/(?:^|\s)(\S*docs\/\S+?\.md)\b/g)) added = (await maybeTrack($, m[1]!)) || added
    if (added) await refresh($)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    const ran = await next(e)
    // A question left only in the reply scrolls away; send Claude back once to pin it
    if (ran.block || e.stop_hook_active || !asksUser(e.last_assistant_message ?? '')) return ran
    if ((await read($, decisions)).length > 0) return ran
    return { ...ran, block: NUDGE }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { deny: 'Only the main conversation updates the Fokusboard.' }
    const change = e as Update
    const before = await readBoard($)
    const board = applyUpdate(before, change)
    await update($, thread, () => board.thread)
    await update($, topic, () => board.topic)
    await update($, todos, () => board.todos)
    await update($, decisions, () => board.decisions)
    await update($, artifacts, () => board.artifacts)
    await update($, log, () => board.log)
    for (const p of change.track_plans ?? []) await maybeTrack($, p, true)
    if (change.untrack_plans?.length) {
      const gone = new Set(await Promise.all(change.untrack_plans.map(async p => planOf(await absolute($, p)))))
      await update($, plans, list => list.filter(p => !gone.has(p)))
    }
    await refresh($)
    await save($)
    const status = await read($, planStatus)
    // Opens by itself the first time something lands on an empty board
    if (isEmpty(before) && (!isEmpty(board) || status.length > 0)) await open($)
    const kept =
      change.thread && before.thread && !change.thread.why?.trim()
        ? 'Thread unchanged: it is the stable anchor; pass thread.why if the overall goal really changed.\n'
        : ''
    return { result: kept + describeBoard(board, status, await read($, mode), await read($, lastCodeEditAt)) }
  })

  // Plans Claude writes, edits or presents with ExitPlanMode join the board; code edits mark implementation
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || !('result' in ran) || ran.isError) return ran
    let path: string | undefined
    if (e.tool === 'ExitPlanMode') path = (ran.result as { filePath?: string } | undefined)?.filePath
    if (e.tool === 'Write' || e.tool === 'Edit') path = (e as { file_path?: string }).file_path
    if (!path) return ran
    const wasEmpty = (await read($, plans)).length === 0
    const tracked = e.tool === 'ExitPlanMode' ? await maybeTrack($, path, true) : await maybeTrack($, path)
    if (!path.endsWith('.md')) await update($, lastCodeEditAt, () => Date.now())
    if (tracked || isDocsMd(path) || (await read($, plans)).length > 0) await refresh($)
    if (tracked && wasEmpty) await open($)
    return ran
  })

  // An update is one dim line in the transcript; the board itself is in the pane
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{summarize((e.props.input ?? {}) as Update)}</Text>
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) =>
    e.props.isErrored ? next(e) : $.ui.resolve(e).Text({ children: [''] }),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    // The remote surfaces draw vector icons; the terminal has no Svg and gets a glyph
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    // One cell of padding on every side
    const inner = Math.max(10, e.props.bodyColumns - 2)
    const { thread: th, topic: tp, todos: allTodos, decisions: allDecisions, artifacts: allArtifacts } = await readBoard($)
    const status = await read($, planStatus)
    const currentMode = await read($, mode)
    const codeEdit = await read($, lastCodeEditAt)
    const allLog = await read($, log)
    const isLogOpen = await read($, showLog)
    const allNotices = await read($, notices)
    const saved = await read($, offer)
    const now = Date.now()
    const doneCount = allTodos.filter(t => t.isDone).length

    // One label style for every section: dim uppercase, the count beside it in the section's colour
    const header = (title: string, count: string, color?: string) => (
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        <Box flexShrink={0}>
          <Text dimColor>
            {title.toUpperCase()}
            {count && <Text color={color}>{'  ' + count}</Text>}
            {' '}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate">
            {'─'.repeat(200)}
          </Text>
        </Box>
      </Box>
    )
    // A ten-cell bar of finished todos
    const progress = (done: number, total: number) => {
      const full = total ? Math.round((done / total) * 10) : 0
      return (
        <Text>
          <Text color="success">{'▰'.repeat(full)}</Text>
          <Text dimColor>{'▱'.repeat(10 - full)}</Text>
        </Text>
      )
    }
    const empty = (text: string) => <Text dimColor>  {text}</Text>
    // The bullet sits in a fixed column at the top of its row, so wrapped lines indent under the text
    const item = (bullet: string, text: string, width: number, isDim = false, color?: string) => (
      <Box flexDirection="row" alignItems="flex-start" width={width}>
        <Box width={4} flexShrink={0}>
          <Text dimColor={isDim} color={color}>{'  ' + bullet}</Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor={isDim} color={color} wrap="wrap">
            {text}
          </Text>
        </Box>
      </Box>
    )

    // The topic card: a rounded frame in the accent colour, so it reads as the headline of the pane
        const topicCard = tp ? (
      <Box flexDirection="column" width={inner}>
        <Box width={inner} marginBottom={1}>{header('Aktuell', '')}</Box>
        <Box flexDirection="row" alignItems="flex-start" width={inner}>
          <Box width={2} flexShrink={0}>
            {Svg ? <Svg source={FOCUS_ICON} alt="Thema" width={15} height={15} /> : <Text color="claude">◎</Text>}
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text bold wrap="wrap">
              {tp.title}
            </Text>
          </Box>
        </Box>
        <Box width={inner}>
          <Text wrap="wrap">{tp.summary}</Text>
        </Box>
        {tp.points.map(p => (
          <Box flexDirection="row" alignItems="flex-start" width={inner}>
            <Box width={2} flexShrink={0}>
              <Text color="claude">•</Text>
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              <Text dimColor wrap="wrap">
                {p}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    ) : th ? null : (
      <Box width={inner} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>Noch kein Thema. Claude setzt es, sobald das Gespräch eins hat.</Text>
      </Box>
    )

    // The anchor of the conversation: what it is about overall, read before the current step
    const threadBlock = th ? (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        <Box width={inner} marginBottom={1}>{header('Worum es geht', '')}</Box>
        <Text bold color="claude" wrap="wrap">
          {th.title}
        </Text>
        <Box width={inner}>
          <Text wrap="wrap">{th.goal}</Text>
        </Box>
      </Box>
    ) : null

    const TONE = { ok: 'success', wait: undefined, warn: 'warning', busy: 'suggestion' } as const
    const isPlanMode = currentMode === 'plan'
    // The terminal opens file:// links itself; the desktop draws only https links, so there a button opens the file
    const fileLink = (href: string, label: string, isThere: boolean) => {
      if (!isThere) return <Text dimColor>{label}</Text>
      if (e.surface === 'terminal') {
        return (
          <Text>
            <Link href={'file://' + href} label={label} />
          </Text>
        )
      }
      return <Button key={'open:' + href} label={label} plain onPress={() => openFile($, href)} />
    }

    // One block per plan: name, the five-step pipeline, where it stands, and its three files as links
    const planBlock = (s: PlanStatus) => {
      const stage = stageOf(s, codeEdit)
      const base = s.path.replace(/\.md$/, '')
      return (
        <Box flexDirection="column" width={inner} marginBottom={1}>
          <Text bold wrap="truncate-middle">
            {'  ' + s.name}
          </Text>
          <Box flexDirection="row" flexWrap="wrap" width={inner} paddingLeft={2}>
            {pipeline(stage.step).map((x, i) => (
              <Text
                color={x.state === 'current' ? TONE[stage.tone] ?? 'claude' : x.state === 'passed' ? 'success' : undefined}
                dimColor={x.state === 'ahead'}
                bold={x.state === 'current'}
              >
                {(i > 0 ? ' ' : '') + (x.state === 'passed' ? '●' : x.state === 'current' ? '◉' : '○') + ' ' + x.label}
              </Text>
            ))}
          </Box>
          <Box paddingLeft={2} width={inner}>
            <Text color={TONE[stage.tone]} wrap="wrap">
              {'→ ' + stage.label}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" paddingLeft={2} width={inner}>
            <Text dimColor>{'Review: '}</Text>
            <Text color={s.latestReview === null ? undefined : s.latestReview > (s.integratedReview ?? 0) ? 'warning' : 'success'} dimColor={s.latestReview === null}>
              {s.latestReview === null
                ? '—'
                : s.latestReview > (s.integratedReview ?? 0)
                  ? `#${s.latestReview} offen`
                  : `#${s.latestReview} eingearbeitet`}
            </Text>
            <Text dimColor>{'  ·  Verify: '}</Text>
            <Text
              color={s.verifyResult === 'vollständig' ? 'success' : s.verifyResult ? 'warning' : undefined}
              dimColor={!s.verifyResult}
            >
              {s.verifyResult ? `${s.verifyResult} (v${s.verifiedVersion})` : '—'}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" paddingLeft={2} width={inner}>
            <Text dimColor>{'↗ '}</Text>
            {fileLink(s.path, s.planVersion ? `Plan v${s.planVersion}` : 'Plan', s.exists)}
            <Text dimColor>{' · '}</Text>
            {fileLink(base + '.review.md', s.latestReview ? `Review #${s.latestReview}` : 'Review', s.hasReview)}
            <Text dimColor>{' · '}</Text>
            {fileLink(base + '.verify.md', 'Verify', s.hasVerify)}
          </Box>
        </Box>
      )
    }

    // ① A board saved for this branch in an earlier session, offered back
    const offerCard = saved ? (
      <Box flexDirection="column" width={inner} borderStyle="round" borderColor="suggestion" paddingX={1} marginBottom={1}>
        <Text color="suggestion" bold>
          Weitermachen, wo du aufgehört hast?
        </Text>
        <Text dimColor wrap="wrap">
          {(saved.branch ? `Branch ${saved.branch}` : 'Dieser Ordner') + ' · gespeichert ' + ago(now - saved.savedAt)}
        </Text>
        <Text bold wrap="wrap">
          {saved.board.thread?.title ?? saved.board.topic?.title ?? 'Gespeichertes Board'}
        </Text>
        <Text dimColor wrap="wrap">
          {[
            saved.board.todos.filter(t => !t.isDone).length && `${saved.board.todos.filter(t => !t.isDone).length} offene Todos`,
            saved.board.decisions.length && `${saved.board.decisions.length} offene Fragen`,
            saved.plans.length && `${saved.plans.length} Pläne`,
          ]
            .filter(Boolean)
            .join(' · ') || 'Thema und Zusammenfassung'}
        </Text>
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="restore" label="Weitermachen" hotkey="w" onPress={() => restore($, saved)} />
          <Button key="discard" label="Verwerfen" plain dimColor onPress={() => discard($)} />
        </Box>
      </Box>
    ) : null

    // ② What changed in a plan outside this session, with the step it asks for
    const noticeTone = { review: 'warning', gaps: 'error', verified: 'success' } as const
    const noticeRow = (n: Notice) => (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        <Box flexDirection="row" alignItems="flex-start" width={inner}>
          <Box width={2} flexShrink={0}>
            <Text color={noticeTone[n.kind]}>●</Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text color={noticeTone[n.kind]} bold wrap="wrap">
              {n.label}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" paddingLeft={2} gap={2}>
          {n.kind === 'review' && <Button key={'act:' + n.kind + n.path} label="Einarbeiten" onPress={() => act($, n)} />}
          {n.kind === 'gaps' && <Button key={'act:' + n.kind + n.path} label="Nachbessern" onPress={() => act($, n)} />}
          <Button
            key={'dismiss:' + n.kind + n.path}
            label="ausblenden"
            plain
            dimColor
            onPress={() => update($, notices, list => list.filter(x => !(x.path === n.path && x.kind === n.kind)))}
          />
        </Box>
      </Box>
    )

    // ③ The decision log: question, the answer beneath it, when; folded to the latest
    const shownLog = (isLogOpen ? [...allLog].reverse() : allLog.slice(-1)).slice(0, 30)
    const logEntry = (x: LogEntry) => (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        <Box flexDirection="row" alignItems="flex-start" width={inner}>
          <Box width={2} flexShrink={0}>
            <Text color="success">✓</Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text dimColor wrap="wrap">
              {x.text}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="flex-start" width={inner} paddingLeft={2}>
          <Box width={2} flexShrink={0}>
            <Text color="success">↳</Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="wrap">
              {x.answer || 'beantwortet'}
              <Text dimColor>{'  · ' + ago(now - x.at)}</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    )

    // Open work first; finished plans sink to the bottom
    const sorted = [...status].sort((a, b) => Number(stageOf(a, codeEdit).step === 'done') - Number(stageOf(b, codeEdit).step === 'done'))
    const showWorkflow = isPlanMode || status.length > 0

    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        {offerCard}
        {allNotices.map(noticeRow)}
        {threadBlock}
        {topicCard}
        {(th || tp) && <Text> </Text>}

        {showWorkflow && (
          <Box flexDirection="row" justifyContent="space-between" width={inner} marginBottom={1}>
            {header('Plan-Workflow', status.length ? String(status.length) : '')}
            <Text> </Text>
            {isPlanMode ? (
              <Text bold color="planMode">
                ◉ Planmodus
              </Text>
            ) : (
              <Button key="refresh-plans" label="↻" hotkey="r" plain dimColor onPress={() => refresh($)} />
            )}
          </Box>
        )}
        {showWorkflow && status.length === 0 && empty('Wir planen gerade; der Plan erscheint, sobald er gespeichert ist.')}
        {sorted.map(planBlock)}
        {showWorkflow && status.length > 0 && <Text> </Text>}

        {allArtifacts.length > 0 && <Box width={inner} marginBottom={1}>{header('Artefakte', String(allArtifacts.length))}</Box>}
        {allArtifacts.map(a => (
          <Box flexDirection="row" alignItems="flex-start" width={inner}>
            <Box width={4} flexShrink={0}>
              <Text color="claude">{'  ↗'}</Text>
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-middle">
                <Link href={a.href} label={a.label} />
              </Text>
            </Box>
          </Box>
        ))}
        {allArtifacts.length > 0 && <Text> </Text>}

        {allDecisions.length > 0 && <Box width={inner} marginBottom={1}>{header('Offene Entscheidungen', String(allDecisions.length), 'warning')}</Box>}
        {allDecisions.length > 1 && (
          <Box width={inner} marginBottom={1}>
            <Button key="ask-all" label="Alle Fragen stellen" hotkey="a" plain onPress={() => askAbout($, allDecisions)} />
          </Box>
        )}
        {allDecisions.map(d => (
          <Box flexDirection="column" width={inner} marginBottom={1}>
            {item('◇', d.text, inner, false, 'warning')}
            <Box flexDirection="row" paddingLeft={4} gap={2}>
              <Button key={'reply:' + d.id} label="↩ Antworten" plain dimColor onPress={() => replyTo($, d)} />
              <Button key={'ask:' + d.id} label="? Frag mich" plain dimColor onPress={() => askAbout($, [d])} />
            </Box>
          </Box>
        ))}

        {allLog.length > 0 && (
          <Box flexDirection="row" width={inner} marginBottom={1}>
            {header('Entschieden', String(allLog.length), 'success')}
            {allLog.length > 1 && (
              <Button
                key="toggle-log"
                label={isLogOpen ? ' weniger' : ` alle ${allLog.length}`}
                plain
                dimColor
                onPress={() => update($, showLog, v => !v)}
              />
            )}
          </Box>
        )}
        {shownLog.map(logEntry)}

        {allTodos.length > 0 && <Box width={inner} marginBottom={1}>{header('Todos', `${doneCount}/${allTodos.length}`, doneCount === allTodos.length ? 'success' : undefined)}</Box>}
        {allTodos.length > 0 && (
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            {progress(doneCount, allTodos.length)}
            {doneCount > 0 && (
              <Button
                key="clear-done"
                label="erledigte weg"
                hotkey="c"
                plain
                dimColor
                onPress={() => update($, todos, list => list.filter(t => !t.isDone))}
              />
            )}
          </Box>
        )}
        {allTodos.filter(t => !t.isDone).map(t => (t.isActive ? item('▸', t.text, inner, false, 'warning') : item('○', t.text, inner)))}
        {/* Finished todos fold into one line so open work stays on top */}
        {doneCount > 0 && <Text color="success">{`  ✓ ${doneCount} erledigt`}</Text>}

        {allDecisions.length + allTodos.length === 0 && <Text dimColor>✓ Keine offenen Entscheidungen, keine Todos.</Text>}
      </Box>
    )
  })
}
