// Fokusboard: the current topic, the plan workflow, artifacts, open questions and todos in a side pane.
// Board logic (todos, decisions, the Stop nudge) follows sirkitree/pinboard (MIT).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact, Decision, LogEntry, Note, Notice, PlanStatus, Saved, Step, Thread, Todo, Topic, Weight } from '../types'

const PANE = 'fokusboard'
const TITLE = 'Fokusboard'
const TOOL = 'mcp__fokusboard__update'
const POLL_MS = 5000
// How long a review or verify file this session wrote counts as its own (no notice)
const OWN_WRITE_MS = 60_000

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
const notes = atom({ plugin: 'fokusboard', key: 'notes' } as const, [] as Note[])
const turnStartAt = atom({ plugin: 'fokusboard', key: 'turnStartAt' } as const, 0)
const ownWrites = atom({ plugin: 'fokusboard', key: 'ownWrites' } as const, [] as { path: string; at: number }[])

const DESCRIPTION = [
  "Keep the user's Fokusboard current: a sidebar that stays in view while the transcript scrolls, showing the current topic, the plan workflow, artifacts, open questions and the task list.",
  'thread: what this whole conversation is about, the anchor the user reads first so every later step makes sense. Set it once, early: title 3-8 words, goal 1-3 sentences on the overall aim and why. It stays put while the work moves on; change it only when the overall goal changes fundamentally, and then give why (the board refuses a thread change without why). Never use it for the current step.',
  'topic: the current focus within the thread (what is being worked on right now); set it when a conversation gets a subject, and update it whenever the subject shifts or your understanding changes materially (a decision made, a cause found, a plan agreed).',
  'topic.title: 2-6 words. topic.summary: 1-3 short sentences on where things stand now, not a history. topic.points: up to 5 terse key facts or constraints worth keeping in view.',
  "Write everything on the board in the user's language.",
  'track_plans: paths of plan files (.claude/plans/<name>.md or docs/**/<name>.md of the Plan → Review → Einarbeiten → Umsetzen → Verify workflow, run by hand or as a sol loop) this session works on; the board reads their version headers and .review.md/.verify.md siblings itself. Plans you write, edit or exit plan mode with are tracked automatically. untrack_plans removes them.',
  'add_artifacts: links that matter for the current work ({label, href}): claude.ai artifacts, PRs, docs. remove_artifacts: by href.',
  'open_decisions: every question you put to the user that needs an answer, however small, even a yes/no, wherever it sits in your reply. The user answers from the board, so make each one self-contained: {question, context, options, recommended, weight}. context: 1-3 sentences on why it comes up now and what depends on it. options: 2-4 short answers. recommended: the option you would pick. weight: blocking (work stops until answered), important (shapes the result) or optional (a nicety; a default applies).',
  'Questions you ask with AskUserQuestion land on the board by themselves and close with the answer. edit_decisions: sharpen an open question by id (context, options, recommended, weight), e.g. after explaining it.',
  'decide: close a decision by id once the user has answered, with the answer in a few words (it stays in the decision log the user reads later).',
  'Use todos in place of writing task lists in your reply whenever the work takes 3+ distinct steps. add_todos: one action per item. start_todo: the todo id you are working on now; exactly one at a time. done_todos / remove_todos: todo ids. Mark a todo done only after the work, including any verification, is actually done. clear_done: drop finished todos when a new topic starts.',
  'The current board, with ids, is at the end of your system prompt.',
].join(' ')

const strings = { type: 'array', items: { type: 'string' } }
const WEIGHT = { type: 'string', enum: ['blocking', 'important', 'optional'] }
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
    open_decisions: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: { question: { type: 'string' }, context: { type: 'string' }, options: strings, recommended: { type: 'string' }, weight: WEIGHT },
            required: ['question'],
          },
        ],
      },
    },
    edit_decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, question: { type: 'string' }, context: { type: 'string' }, options: strings, recommended: { type: 'string' }, weight: WEIGHT },
        required: ['id'],
      },
    },
    decide: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] },
    },
  },
}

export type QuestionInput = { question: string; context?: string; options?: string[]; recommended?: string; weight?: Weight }

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
  open_decisions?: (string | QuestionInput)[]
  edit_decisions?: ({ id: string } & Partial<QuestionInput>)[]
  decide?: { id: string; answer: string }[]
}

export type Board = { thread: Thread | null; topic: Topic | null; todos: Todo[]; decisions: Decision[]; artifacts: Artifact[]; log: LogEntry[] }

// The next id for a prefix: one past the highest in use
const nextId = (prefix: string, ids: string[]) =>
  prefix + (Math.max(0, ...ids.map(id => Number(id.slice(prefix.length)) || 0)) + 1)

// The fields of a question as the board keeps them: trimmed, empty ones left out
function questionFields(q: Partial<QuestionInput>): Partial<Omit<Decision, 'id' | 'at'>> {
  const options = q.options?.map(o => o.trim()).filter(Boolean).slice(0, 4)
  return {
    ...(q.question?.trim() && { text: q.question.trim() }),
    ...(q.context?.trim() && { context: q.context.trim() }),
    ...(options?.length && { options }),
    ...(q.recommended?.trim() && { recommended: q.recommended.trim() }),
    ...(q.weight && { weight: q.weight }),
  }
}

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
  for (const q of change.open_decisions ?? []) {
    const fields = questionFields(typeof q === 'string' ? { question: q } : q)
    if (fields.text) d = [...d, { id: nextId('d', d.map(x => x.id)), ...fields, text: fields.text, at: now }]
  }
  for (const edit of change.edit_decisions ?? []) d = d.map(x => (x.id === edit.id ? { ...x, ...questionFields(edit) } : x))
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

// ── Questions ───────────────────────────────────────────────────────────────

// Lowercase words of three letters or more, for matching a question against the board
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])

// Whether a question line is already on the board: most of its words appear in one open decision
export function isCovered(line: string, list: Decision[]): boolean {
  const mine = [...words(line)]
  if (mine.length === 0) return true
  return list.some(d => {
    const theirs = words(`${d.text} ${d.context ?? ''}`)
    return mine.filter(w => theirs.has(w)).length / mine.length >= 0.5
  })
}

// The questions a reply puts to the user: lines among its last ones, outside code, ending in a question mark
export function questionsIn(reply: string): string[] {
  const prose = reply.replace(/```[\s\S]*?```/g, '')
  const lines = prose.split('\n').map(l => l.trim()).filter(Boolean).slice(-10)
  return lines.filter(l => /\?[*_`)"'\]]*$/.test(l))
}

export const asksUser = (reply: string) => questionsIn(reply).length > 0

// The dialog's questions as board decisions: a question already open is reused, not doubled
export function fromDialog(list: Decision[], questions: { question: string; header?: string; options?: { label: string; description?: string }[] }[], now: number) {
  let next = list
  const ids: { id: string; question: string }[] = []
  for (const q of questions) {
    const same = next.find(d => d.text.trim().toLowerCase() === q.question.trim().toLowerCase())
    if (same) {
      ids.push({ id: same.id, question: q.question })
      continue
    }
    const labels = (q.options ?? []).map(o => o.label)
    const recommended = labels.find(l => /\((recommended|empfohlen)\)/i.test(l))
    const id = nextId('d', next.map(x => x.id))
    next = [
      ...next,
      {
        id,
        text: q.question.trim(),
        ...(q.header && { context: q.header }),
        ...(labels.length && { options: labels.map(l => l.replace(/\s*\((recommended|empfohlen)\)/i, '')) }),
        ...(recommended && { recommended: recommended.replace(/\s*\((recommended|empfohlen)\)/i, '') }),
        weight: 'important' as const,
        at: now,
      },
    ]
    ids.push({ id, question: q.question })
  }
  return { decisions: next, ids }
}

const NUDGE =
  'Your reply asks the user something that is not on the Fokusboard. ' +
  'Call mcp__fokusboard__update with open_decisions for each open question ({question, context, options, recommended, weight}; close it with decide once answered), then end your turn. ' +
  'If it was rhetorical or is already on the board, end your turn as is.'

// ── Plan workflow ────────────────────────────────────────────────────────────

// <name>.review.md and <name>.verify.md belong to <name>.md
export const planOf = (path: string) => path.replace(/\.(review|verify)\.md$/, '.md')

const maxOf = (text: string, re: RegExp) => {
  const all = [...text.matchAll(re)].map(m => Number(m[1]))
  return all.length ? Math.max(...all) : null
}

// Who wrote a review, from its "Geprüft gegen Plan Version #M · <who>" line
export function reviewerOf(by: string): string | null {
  const who = by.trim()
  if (!who) return null
  if (/\bSol\b/.test(who)) {
    const round = who.match(/Runde (\d+)/)
    return round ? `Sol, Runde ${round[1]}` : 'Sol'
  }
  if (/codex/i.test(who)) return 'Codex'
  return who.length > 30 ? who.slice(0, 29) + '…' : who
}

// Reads the version headers the workflow skills write (plan-review, plan-integrate-review, plan-verify)
export function parseHeaders(plan: string, review: string, verify: string) {
  const integrated = maxOf(plan, /Plan Version #\d+\s*[—–-]+\s*Review #(\d+) eingearbeitet/g)
  const partial = maxOf(plan, /Plan Version #\d+\s*[—–-]+\s*Review #(\d+) teilweise eingearbeitet/g)
  const verdicts = [
    ...verify.matchAll(/Verifikation gegen Plan Version #(\d+)\s*[—–-]+\s*Ergebnis:?[\s*_`[]*(vollständig|Lücken|unvollständig)/gi),
  ]
  const last = verdicts.at(-1)
  const word = last?.[2]?.toLowerCase()
  const result: PlanStatus['verifyResult'] = word === 'lücken' ? 'Lücken' : word === 'vollständig' || word === 'unvollständig' ? word : null
  // The latest review is the section from its last "Review Version #N" on
  const head = [...review.matchAll(/Review Version #(\d+)/g)].at(-1)
  const section = head ? review.slice(head.index) : ''
  const against = section.match(/Geprüft gegen Plan Version #(\d+)(?:\s*·\s*([^\n]+))?/)
  const count = (tag: string) => section.split(`[${tag}]`).length - 1
  return {
    planVersion: maxOf(plan, /Plan Version #(\d+)/g),
    integratedReview: integrated,
    isPartial: partial !== null && partial > (integrated ?? 0),
    latestReview: maxOf(review, /Review Version #(\d+)/g),
    reviewBy: reviewerOf(against?.[2] ?? ''),
    reviewedVersion: against ? Number(against[1]) : null,
    findings: { critical: count('kritisch'), important: count('wichtig'), optional: count('optional') },
    verifiedVersion: last ? Number(last[1]) : null,
    verifyResult: result,
  }
}

export type Stage = { step: Step; label: string; tone: 'ok' | 'wait' | 'warn' | 'busy' }

// Where a plan stands, from its headers alone (and whether code changed since the plan was settled)
export function stageOf(s: PlanStatus, lastCodeEdit: number): Stage {
  if (!s.exists) return { step: 'plan', label: 'Plan wird geschrieben', tone: 'busy' }
  if (!s.hasReview || s.latestReview === null) return { step: 'review', label: 'Review fehlt', tone: 'wait' }
  if (s.latestReview > (s.integratedReview ?? 0)) {
    return s.isPartial
      ? { step: 'integrate', label: `Review #${s.latestReview} teilweise eingearbeitet: Offenes klären`, tone: 'warn' }
      : { step: 'integrate', label: `Review #${s.latestReview} einarbeiten`, tone: 'warn' }
  }
  if (!s.hasVerify || s.verifiedVersion === null) {
    return lastCodeEdit > s.planMtime
      ? { step: 'implement', label: 'Umsetzung läuft', tone: 'busy' }
      : { step: 'implement', label: 'bereit zur Umsetzung, wartet auf dein Go', tone: 'wait' }
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
  { step: 'integrate', label: 'Einarbeiten' },
  { step: 'implement', label: 'Umsetzen' },
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

export type NextStep = { key: string; label: string; text: string }

// What a plan's stage asks for next: buttons that put the command in the prompt box, and the manual route as a hint
export function nextSteps(s: PlanStatus, stage: Stage, rel: string): { buttons: NextStep[]; hint: string | null } {
  const verifyFile = rel.replace(/\.md$/, '.verify.md')
  const solPlan = { key: 'sol-plan', label: 'Sol-Loop', text: `sol loop plan ${rel}` }
  const solVerify = { key: 'sol-verify', label: 'Sol-Verify', text: `sol loop verify ${rel}` }
  if (stage.step === 'review') return { buttons: [solPlan], hint: `manuell: in Codex $plan-review ${rel}` }
  if (stage.step === 'integrate') {
    if (s.isPartial) return { buttons: [], hint: 'Die offenen Punkte stehen unter „Offen:“ im Plan.' }
    return { buttons: [{ key: 'integrate', label: 'Einarbeiten', text: `/workflow:plan-integrate-review ${rel}` }, solPlan], hint: null }
  }
  if (stage.step === 'implement' && stage.tone === 'wait') {
    return { buttons: [{ key: 'implement', label: 'Umsetzen', text: `Setze ${rel} um.` }], hint: null }
  }
  if (stage.step === 'implement' || stage.step === 'verify') {
    const fix = s.verifyResult && s.verifyResult !== 'vollständig' && stage.label.startsWith('Nachbessern')
    return {
      buttons: [
        ...(fix ? [{ key: 'fix', label: 'Nachbessern', text: `Lies ${verifyFile} und schließe die Lücken im Rahmen des Plans.` }] : []),
        solVerify,
      ],
      hint: `manuell: in Codex $plan-verify ${rel}`,
    }
  }
  return { buttons: [], hint: null }
}

// "1 kritisch · 2 wichtig", or empty without findings
export function findingsText(f: PlanStatus['findings']): string {
  if (!f) return ''
  return [f.critical && `${f.critical} kritisch`, f.important && `${f.important} wichtig`, f.optional && `${f.optional} optional`]
    .filter(Boolean)
    .join(' · ')
}

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
  // A review or verify this session wrote (a sol loop) is its own work in progress, not news
  const now = Date.now()
  const own = new Set((await read($, ownWrites)).filter(w => now - w.at < OWN_WRITE_MS).map(w => w.path))
  const fresh = noticesFor(before, next, now).filter(n => !own.has(n.path))
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

// A path the workflow knows: a Markdown file under .claude/plans/ or docs/
export const isPlanPath = (path: string) => /(^|\/)(docs|\.claude\/plans)\/.+\.md$/.test(path)

async function absolute($: EngineInterface, path: string) {
  if (path.startsWith('/')) return path
  const cwd = await $.session.cwd()
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}

// Tracks a plan-folder Markdown file when it is a plan of the workflow (or one of its review/verify files)
async function maybeTrack($: EngineInterface, raw: string, force = false) {
  if (!force && !isPlanPath(raw)) return false
  const path = planOf(await absolute($, raw))
  if ((await read($, plans)).includes(path)) return false
  if (!force) {
    const base = path.replace(/\.md$/, '')
    const text = (await readOr($, path)).text
    const isPlan = /Plan Version #\d+/.test(text) || (await $.fs.exists(base + '.review.md')) || raw !== path
    if (!isPlan) return false
  }
  await update($, plans, list => [...list, path].slice(-6))
  return true
}

// ── Board text for the system prompt ────────────────────────────────────────

const WEIGHT_WORD: Record<Weight, string> = { blocking: 'blocking', important: 'important', optional: 'optional' }

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
  lines.push(
    ...board.decisions.map(
      d => `${d.id} [?${d.weight && d.weight !== 'important' ? ' ' + WEIGHT_WORD[d.weight] : ''}] ${d.text}${d.recommended ? ` (recommended: ${d.recommended})` : ''}`,
    ),
  )
  lines.push(...board.log.slice(-5).map(x => `Decided: ${x.text} → ${x.answer}`))
  return lines.join('\n')
}

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
    change.open_decisions?.length && `+${change.open_decisions.length} question`,
    change.edit_decisions?.length && `${change.edit_decisions.length} question sharpened`,
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

// The footer switch: closes the board when it is open, else refreshes and opens it
const toggle = async ($: EngineInterface) => {
  if ((await $.ui.panes()).some(p => p.id === PANE)) return void (await $.ui.close({ id: PANE }))
  await refresh($)
  await open($)
}

// Puts text in the prompt box for the person to send, after what is already there; where no box takes it, sends it
async function put($: EngineInterface, text: string) {
  const { text: now } = await $.prompt.read()
  const { isFilled } = await $.prompt.fill(now.trim() ? { text: `\n${text}`, mode: 'append' } : { text, mode: 'replace' })
  if (!isFilled) await $.prompt.submit({ text })
}

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
  const lines = list
    .map(d => `${d.id}: ${d.text}${d.options?.length ? ` (Optionen: ${d.options.join(' / ')}${d.recommended ? `; empfohlen: ${d.recommended}` : ''})` : ''}`)
    .join('\n')
  await $.prompt.submit({
    text:
      `Stell mir ${list.length === 1 ? 'diese offene Frage' : 'diese offenen Fragen'} vom Fokusboard jetzt direkt ` +
      `mit AskUserQuestion, den Fragetext wörtlich, mit sinnvollen Antwortoptionen und je einer kurzen Beschreibung, was die Option bewirkt:\n${lines}`,
  })
  await $.ui.toast(list.length === 1 ? 'Claude stellt dir die Frage gleich.' : `Claude stellt dir die ${list.length} Fragen gleich.`)
}

// Has Claude explain a question and its context before the person decides
async function explain($: EngineInterface, d: Decision) {
  await $.prompt.submit({
    text:
      `Erklär mir die offene Frage ${d.id} vom Fokusboard, bevor ich entscheide: „${d.text}“. ` +
      'Worum geht es, warum stellt sie sich jetzt, was hängt davon ab, welche Optionen gibt es mit ihren Folgen, und was empfiehlst du? ' +
      'Kurz, mit einer Skizze, wenn sie hilft. Noch nichts entscheiden oder umsetzen; ergänze danach Kontext, Optionen und Empfehlung der Frage mit edit_decisions.',
  })
}

// Closes a question the person no longer needs answered; it stays in the log as dismissed
async function dismiss($: EngineInterface, d: Decision) {
  const board = applyUpdate(await readBoard($), { decide: [{ id: d.id, answer: 'verworfen' }] })
  await update($, decisions, () => board.decisions)
  await update($, log, () => board.log)
}

// Opens a plan file in the Mac's default app for Markdown
async function openFile($: EngineInterface, path: string) {
  const { exitCode, stderr } = await $.process.run(['open', path])
  if (exitCode !== 0) await $.ui.toast(`Konnte ${path.split('/').at(-1)} nicht öffnen: ${stderr.trim()}`)
}

// ── The person's own notes, kept per repository and branch ──────────────────

// The store key of this checkout: its repository root and branch, or the folder outside git
async function storeKey($: EngineInterface): Promise<string> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (top.exitCode === 0 && head.exitCode === 0) return `board:${top.stdout.trim()}:${head.stdout.trim()}`
  } catch {}
  return `board:${await $.session.cwd().catch(() => 'unknown')}`
}

export function addNote(list: Note[], text: string, now: number): Note[] {
  const clean = text.trim()
  if (!clean) return list
  return [...list, { id: `n${now.toString(36)}${list.length}`, text: clean, isDone: false, at: now }].slice(-50)
}

export const toggleNote = (list: Note[], id: string): Note[] => list.map(n => (n.id === id ? { ...n, isDone: !n.isDone } : n))

// Open notes first, in the order they were written; finished ones after them
export const sortNotes = (list: Note[]): Note[] => [...list.filter(n => !n.isDone), ...list.filter(n => n.isDone)]

export function describeNotes(list: Note[]): string {
  if (list.length === 0) return ''
  return [
    "The user's own notes (their list; read them, never change them):",
    ...list.map(n => `  [${n.isDone ? 'x' : ' '}] ${n.text}`),
  ].join('\n')
}

async function changeNotes($: EngineInterface, fn: (list: Note[]) => Note[]) {
  await update($, notes, fn)
  // Saving is a convenience: a store or git that fails never stops the board
  try {
    await $.store.set(await storeKey($), { notes: await read($, notes) } satisfies Saved)
  } catch {}
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

// The step a notice asks for, put in the prompt box: the integrate command, or closing the gaps
async function act($: EngineInterface, n: Notice) {
  const rel = await relative($, n.path)
  if (n.kind === 'review') await put($, `/workflow:plan-integrate-review ${rel}`)
  else if (n.kind === 'gaps') await put($, `Lies ${rel.replace(/\.md$/, '.verify.md')} und schließe die Lücken im Rahmen des Plans.`)
  await update($, notices, list => list.filter(x => !(x.path === n.path && x.kind === n.kind)))
}

// The mode rides on every classic hook's input; keep the latest
const noteMode = async ($: EngineInterface, value: string | undefined) => {
  if (value && value !== (await read($, mode))) await update($, mode, () => value)
}

const WEIGHTS: { weight: Weight; label: string; bullet: string; color?: string }[] = [
  { weight: 'blocking', label: 'Blockiert die Arbeit', bullet: '●', color: 'error' },
  { weight: 'important', label: 'Wichtig', bullet: '◆', color: 'warning' },
  { weight: 'optional', label: 'Optional', bullet: '◇' },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fokus', description: 'Open the Fokusboard: topic, plan workflow, questions, todos', immediate: true })
    await $.tool.register({ name: 'update', description: DESCRIPTION, inputSchema: SCHEMA })
    // Codex writes .review.md and .verify.md outside this session; poll the tracked plans
    void $.clock.every(POLL_MS, async () => {
      if ((await read($, plans)).length > 0) await refresh($)
    })
    // The person's notes come back on their branch; the board itself starts fresh
    if ((await read($, notes)).length === 0) {
      try {
        const saved = (await $.store.get(await storeKey($))) as Saved | undefined
        if (saved?.notes?.length) await update($, notes, () => saved.notes ?? [])
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
    const own = describeNotes(await read($, notes))
    const text =
      (own ? own + '\n' : '') +
      describeBoard(await readBoard($), await read($, planStatus), await read($, mode), await read($, lastCodeEditAt))
    return { sections: [...sections, { id: 'fokusboard:board', text, scope: 'session' }] }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    await update($, turnStartAt, () => Date.now())
    // A plan path in the prompt (sol loop plan .claude/plans/x.md, /workflow:plan-verify …) joins the board
    let added = false
    for (const m of (e.prompt ?? '').matchAll(/(?:^|\s)(\S*(?:docs|\.claude\/plans)\/\S+?\.md)\b/g)) added = (await maybeTrack($, m[1]!)) || added
    if (added) await refresh($)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    const ran = await next(e)
    // A question left only in the reply scrolls away; send Claude back once to pin it
    if (ran.block || e.stop_hook_active) return ran
    const asked = questionsIn(e.last_assistant_message ?? '')
    if (asked.length === 0) return ran
    const start = await read($, turnStartAt)
    const pending = await read($, decisions)
    // This turn already put a question on the board, or answered one in a dialog
    if (pending.some(d => (d.at ?? 0) >= start) || (await read($, log)).some(x => x.at >= start)) return ran
    if (asked.every(q => isCovered(q, pending))) return ran
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
    const status = await read($, planStatus)
    // Opens by itself the first time something lands on an empty board
    if (isEmpty(before) && (!isEmpty(board) || status.length > 0)) await open($)
    const kept =
      change.thread && before.thread && !change.thread.why?.trim()
        ? 'Thread unchanged: it is the stable anchor; pass thread.why if the overall goal really changed.\n'
        : ''
    return { result: kept + describeBoard(board, status, await read($, mode), await read($, lastCodeEditAt)) }
  })

  // A dialog's questions show on the board while it is open and close with the person's answers
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const { decisions: opened, ids } = fromDialog(await read($, decisions), e.questions ?? [], Date.now())
    await update($, decisions, () => opened)
    const ran = await next(e)
    const answers = 'result' in ran && !ran.isError ? ((ran.result as { answers?: Record<string, string> } | undefined)?.answers ?? {}) : {}
    const decide = ids.filter(x => answers[x.question]?.trim()).map(x => ({ id: x.id, answer: answers[x.question]! }))
    if (decide.length) {
      const board = applyUpdate(await readBoard($), { decide })
      await update($, decisions, () => board.decisions)
      await update($, log, () => board.log)
    }
    return ran
  })

  // Plans Claude writes, edits or presents with ExitPlanMode join the board; code edits mark implementation
  on('tool.call', async ($, e, next) => {
    const target = e.tool === 'Write' || e.tool === 'Edit' ? (e as { file_path?: string }).file_path : undefined
    // A review or verify this session writes (a sol loop) is marked before it lands, so the poll raises no notice
    if (!e.agentId && target && /\.(review|verify)\.md$/.test(target)) {
      const plan = planOf(await absolute($, target))
      await update($, ownWrites, list => [...list.filter(w => w.path !== plan && Date.now() - w.at < OWN_WRITE_MS), { path: plan, at: Date.now() }])
    }
    const ran = await next(e)
    if (e.agentId || !('result' in ran) || ran.isError) return ran
    let path: string | undefined = target
    if (e.tool === 'ExitPlanMode') path = (ran.result as { filePath?: string } | undefined)?.filePath
    if (!path) return ran
    const wasEmpty = (await read($, plans)).length === 0
    const tracked = e.tool === 'ExitPlanMode' ? await maybeTrack($, path, true) : await maybeTrack($, path)
    if (!path.endsWith('.md')) await update($, lastCodeEditAt, () => Date.now())
    if (tracked || isPlanPath(path) || (await read($, plans)).length > 0) await refresh($)
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

  // "◎ Fokus" beside the footer's mode labels (`focus`, …): one click opens or closes the board
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="fokus-toggle" plain dimColor onPress={() => toggle($)}>
          ◎ Fokus
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    // The mobile app draws no text field yet; there the notes are read-only
    const Input = 'Input' in elements ? elements.Input : undefined
    // The remote surfaces draw vector icons; the terminal has no Svg and gets a glyph
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    // The terminal frames the whole board; inside it, one cell of padding on every side
    const isTerminal = e.surface === 'terminal'
    const frame = isTerminal ? 2 : 0
    const inner = Math.max(10, e.props.bodyColumns - 2 - frame)
    const { thread: th, topic: tp, todos: allTodos, decisions: allDecisions, artifacts: allArtifacts } = await readBoard($)
    const status = await read($, planStatus)
    const currentMode = await read($, mode)
    const codeEdit = await read($, lastCodeEditAt)
    const allLog = await read($, log)
    const isLogOpen = await read($, showLog)
    const allNotices = await read($, notices)
    const ownNotes = await read($, notes)
    const ownDone = ownNotes.filter(n => n.isDone).length
    const cwd = (await $.session.cwd().catch(() => '')).replace(/\/$/, '') + '/'
    const rel = (path: string) => (path.startsWith(cwd) ? path.slice(cwd.length) : path)
    const now = Date.now()
    const doneCount = allTodos.filter(t => t.isDone).length

    // One label style for every section: dim uppercase, the count beside it in the section's colour
    // The terminal counts cells, so its rule is drawn to the exact width (no "…" from truncation);
    // the desktop's proportional font cannot be counted, so there a long rule is clipped by its box
    const header = (title: string, count: string, color?: string, width = inner) => {
      const label = title.toUpperCase() + (count ? '  ' + count : '') + ' '
      return (
        <Box flexDirection="row" flexGrow={1} flexShrink={1}>
          <Box flexShrink={0}>
            <Text dimColor>
              {title.toUpperCase()}
              {count && <Text color={color}>{'  ' + count}</Text>}
              {' '}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Text dimColor wrap="truncate">
              {'─'.repeat(isTerminal ? Math.max(0, width - label.length) : 200)}
            </Text>
          </Box>
        </Box>
      )
    }
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
    const item = (bullet: string, text: string, width: number, isDim = false, color?: string, isBold = false, textColor = color) => (
      <Box flexDirection="row" alignItems="flex-start" width={width}>
        <Box width={4} flexShrink={0}>
          <Text dimColor={isDim} color={color}>{'  ' + bullet}</Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor={isDim} color={textColor} bold={isBold} wrap="wrap">
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
      <Box width={inner} marginBottom={1}>
        <Text dimColor wrap="wrap">
          Noch kein Thema. Claude setzt es, sobald das Gespräch eins hat.
        </Text>
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

    // One block per open plan: name and version; the step as dots and words; the review in one line;
    // what to do next as buttons (Sol or by hand); the three files
    const planBlock = (s: PlanStatus) => {
      const stage = stageOf(s, codeEdit)
      const base = s.path.replace(/\.md$/, '')
      const steps = pipeline(stage.step)
      const at = steps.findIndex(x => x.state === 'current')
      const next = nextSteps(s, stage, rel(s.path))
      const review =
        s.latestReview === null
          ? null
          : [
              `Review #${s.latestReview}`,
              s.reviewBy,
              s.reviewedVersion !== null && s.reviewedVersion !== undefined && `gegen v${s.reviewedVersion}`,
              s.latestReview > (s.integratedReview ?? 0) ? findingsText(s.findings) || 'offen' : 'eingearbeitet',
            ]
              .filter(Boolean)
              .join(' · ')
      return (
        <Box flexDirection="column" width={inner} marginBottom={1}>
          <Box flexDirection="row" width={inner}>
            <Box flexShrink={1} flexGrow={1}>
              <Text bold wrap="truncate-middle">
                {'  ' + s.name}
              </Text>
            </Box>
            {s.planVersion !== null && (
              <Box flexShrink={0}>
                <Text dimColor>{' v' + s.planVersion}</Text>
              </Box>
            )}
          </Box>
          <Box flexDirection="row" alignItems="flex-start" width={inner} paddingLeft={2}>
            <Box flexShrink={0}>
              <Text>
                {steps.map(x => (
                  <Text
                    color={x.state === 'current' ? TONE[stage.tone] ?? 'claude' : x.state === 'passed' ? 'success' : undefined}
                    dimColor={x.state === 'ahead'}
                  >
                    {x.state === 'passed' ? '●' : x.state === 'current' ? '◉' : '○'}
                  </Text>
                ))}
                {'  '}
              </Text>
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              <Text color={TONE[stage.tone]} wrap="wrap">
                {(at >= 0 ? `${at + 1}/5 ${steps[at]!.label}: ` : '') + stage.label}
              </Text>
            </Box>
          </Box>
          {review && (
            <Box paddingLeft={2} width={inner}>
              <Text dimColor wrap="wrap">
                {review}
              </Text>
            </Box>
          )}
          {s.verifyResult && (
            <Box paddingLeft={2} width={inner}>
              <Text color={s.verifyResult === 'vollständig' ? 'success' : 'warning'} wrap="wrap">
                {`Verify: ${s.verifyResult} (gegen v${s.verifiedVersion})`}
              </Text>
            </Box>
          )}
          {next.buttons.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" paddingLeft={2} gap={2} width={inner}>
              {next.buttons.map(b => (
                <Button key={`step:${b.key}:${s.path}`} label={b.label} onPress={() => put($, b.text)} />
              ))}
            </Box>
          )}
          {next.hint && (
            <Box paddingLeft={2} width={inner}>
              <Text dimColor wrap="wrap">
                {next.hint}
              </Text>
            </Box>
          )}
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
    // A finished plan is one line
    const doneLine = (s: PlanStatus) => (
      <Box flexDirection="row" alignItems="flex-start" width={inner}>
        <Box width={4} flexShrink={0}>
          <Text color="success">{'  ✓'}</Text>
        </Box>
        <Box flexShrink={1} flexGrow={1} flexDirection="row" flexWrap="wrap">
          {fileLink(s.path, s.name, s.exists)}
          <Text dimColor>{` v${s.planVersion ?? '?'} · vollständig verifiziert`}</Text>
        </Box>
      </Box>
    )

    // What changed in a plan outside this session, with the step it asks for
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

    // One open question: the question, why it matters, its options (a click answers), and what else to do with it
    const questionCard = (d: Decision, w: (typeof WEIGHTS)[number]) => (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        {item(w.bullet, d.text, inner, w.weight === 'optional', w.color, w.weight !== 'optional', undefined)}
        {d.context && (
          <Box paddingLeft={4} width={inner}>
            <Text dimColor wrap="wrap">
              {d.context}
            </Text>
          </Box>
        )}
        {d.options && d.options.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" paddingLeft={4} gap={1} width={inner}>
            {d.options.map((o, i) => (
              <Button
                key={`opt:${d.id}:${i}`}
                label={o === d.recommended ? `${o} ★` : o}
                // The recommended option is the one drawn as a full button
                plain={o !== d.recommended || undefined}
                onPress={() => put($, `Zu „${d.text}“: ${o}`)}
              />
            ))}
          </Box>
        )}
        {d.recommended && !d.options?.includes(d.recommended) && (
          <Box paddingLeft={4} width={inner}>
            <Text dimColor wrap="wrap">
              {'★ Empfehlung: ' + d.recommended}
            </Text>
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap" paddingLeft={4} gap={2}>
          <Button key={'reply:' + d.id} label="↩ Antworten" plain dimColor onPress={() => replyTo($, d)} />
          <Button key={'ask:' + d.id} label="? Frag mich" plain dimColor onPress={() => askAbout($, [d])} />
          <Button key={'explain:' + d.id} label="✦ Erklär mir das" plain dimColor onPress={() => explain($, d)} />
          <Button key={'drop:' + d.id} label="× verwerfen" plain dimColor onPress={() => dismiss($, d)} />
        </Box>
      </Box>
    )
    const groups = WEIGHTS.map(w => ({ w, list: allDecisions.filter(d => (d.weight ?? 'important') === w.weight) })).filter(g => g.list.length > 0)
    const blocking = groups.find(g => g.w.weight === 'blocking')?.list.length ?? 0

    // The decision log: question, the answer beneath it, when; folded to the latest
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

    // The person's own notes and todos: typed here, ticked off here, never touched by Claude
    const notesBlock = (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        <Box width={inner} marginBottom={1}>
          {header('Meine Notizen', ownNotes.length ? `${ownNotes.length - ownDone}/${ownNotes.length}` : '', ownNotes.length && !ownNotes.some(n => !n.isDone) ? 'success' : undefined)}
        </Box>
        {Input && (
          <Box width={inner}>
            <Input
              key={'note-input-' + ownNotes.length}
              placeholder="Notiz oder Todo hinzufügen…"
              submitLabel="hinzufügen"
              onSubmit={(text: string) => changeNotes($, list => addNote(list, text, Date.now()))}
            />
          </Box>
        )}
        {sortNotes(ownNotes).map(n => (
          <Box flexDirection="row" alignItems="flex-start" width={inner}>
            <Box width={3} flexShrink={0}>
              <Button
                key={'note-toggle:' + n.id}
                label={n.isDone ? '✓' : '○'}
                plain
                onPress={() => changeNotes($, list => toggleNote(list, n.id))}
              />
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="wrap" dimColor={n.isDone} strikethrough={n.isDone}>
                {n.text}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Button key={'note-del:' + n.id} label="×" plain dimColor onPress={() => changeNotes($, list => list.filter(x => x.id !== n.id))} />
            </Box>
          </Box>
        ))}
        {ownDone > 0 && (
          <Box width={inner} justifyContent="flex-end">
            <Button key="notes-clear-done" label="erledigte entfernen" plain dimColor onPress={() => changeNotes($, list => list.filter(n => !n.isDone))} />
          </Box>
        )}
      </Box>
    )

    // Open work first; finished plans fold into one line each below it
    const openPlans = status.filter(s => stageOf(s, codeEdit).step !== 'done')
    const donePlans = status.filter(s => stageOf(s, codeEdit).step === 'done')
    const showWorkflow = isPlanMode || status.length > 0

    return (
      <Box
        flexDirection="column"
        width={inner + 2 + frame}
        paddingX={1}
        paddingY={isTerminal ? 0 : 1}
        // In the terminal the frame fills the pane, so the board reads as one card rather than a box adrift in it
        minHeight={isTerminal ? Math.max(3, e.props.scroll.bodyRows) : undefined}
        borderStyle={isTerminal ? 'round' : undefined}
        borderColor={isTerminal ? 'claude' : undefined}
        borderDimColor={isTerminal}
      >
        {allNotices.map(noticeRow)}
        {threadBlock}
        {topicCard}
        {(th || tp) && <Text> </Text>}

        {/* Open questions come right after the topic: they are what the person acts on */}
        {allDecisions.length > 0 && (
          <Box flexDirection="row" width={inner} marginBottom={1}>
            {header('Offene Fragen', blocking ? `${allDecisions.length} · ${blocking} blockiert` : String(allDecisions.length), blocking ? 'error' : 'warning', allDecisions.length > 1 ? inner - 14 : inner)}
            {allDecisions.length > 1 && <Button key="ask-all" label=" Alle stellen" hotkey="a" plain onPress={() => askAbout($, allDecisions)} />}
          </Box>
        )}
        {groups.map(g => (
          <Box flexDirection="column" width={inner}>
            {groups.length > 1 && (
              <Text color={g.w.color} dimColor={!g.w.color} bold>
                {'  ' + g.w.label}
              </Text>
            )}
            {g.list.map(d => questionCard(d, g.w))}
          </Box>
        ))}

        {notesBlock}

        {showWorkflow && (
          <Box flexDirection="row" justifyContent="space-between" width={inner} marginBottom={1}>
            {header('Plan-Workflow', status.length ? String(status.length) : '', undefined, inner - (isPlanMode ? 12 : 3))}
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
        {openPlans.map(planBlock)}
        {donePlans.map(doneLine)}
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

        {allLog.length > 0 && (
          <Box flexDirection="row" width={inner} marginBottom={1}>
            {header('Entschieden', String(allLog.length), 'success', allLog.length > 1 ? inner - 10 : inner)}
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

        {allDecisions.length + allTodos.length === 0 && <Text dimColor>✓ Keine offenen Fragen, keine Todos.</Text>}
      </Box>
    )
  })
}
