// Fokusboard: the current topic, the plan workflow, artifacts, open questions and todos in a side pane
// (the terminal pane, or in Herdr the herdr plugin's sidebar tab, fed by a snapshot file).
// Board logic (todos, decisions, the Stop nudge) follows sirkitree/pinboard (MIT).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact, Decision, Griff, LogEntry, PlanStatus, SavedBoard, Step, Thread, Todo, Topic, TopicMark, Weight } from '../types'

const PANE = 'fokusboard'
const TITLE = 'Fokusboard'
const TOOL = 'mcp__fokusboard__update'
const POLL_MS = 5000
// How often the Herdr bridge reads the sidebar's clicks and publishes the board
const HERDR_MS = 1000
// How often the board is saved for a later --resume, and how many sessions are kept
const SAVE_MS = 2000
const SAVED_SESSIONS = 30
const BOARDS_KEY = 'boards'
// The person's saved prompts are one list across all sessions
const GRIFFE_KEY = 'griffe'

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
const hideDone = atom({ plugin: 'fokusboard', key: 'hideDone' } as const, false)
const trail = atom({ plugin: 'fokusboard', key: 'trail' } as const, [] as TopicMark[])
const griffe = atom({ plugin: 'fokusboard', key: 'griffe' } as const, [] as Griff[])
const turnStartAt = atom({ plugin: 'fokusboard', key: 'turnStartAt' } as const, 0)

const DESCRIPTION = [
  "Keep the user's Fokusboard current: a sidebar that stays in view while the transcript scrolls, showing the current topic, the plan workflow, artifacts, open questions and the task list.",
  'thread: what this whole conversation is about, the anchor the user reads first so every later step makes sense. Set it once, early: title 3-8 words, goal 1-3 sentences on the overall aim and why. It stays put while the work moves on; change it only when the overall goal changes fundamentally, and then give why (the board refuses a thread change without why). Never use it for the current step.',
  'topic: the current focus within the thread (what is being worked on right now); set it when a conversation gets a subject, and update it whenever the subject shifts or your understanding changes materially (a decision made, a cause found, a plan agreed).',
  'topic.title: 2-6 words. topic.summary: 1-3 short sentences on where things stand now, not a history. topic.points: up to 5 terse key facts or constraints worth keeping in view.',
  "Write everything on the board in the user's language.",
  'track_plans: paths of plan files (.claude/plans/<name>.md or docs/**/<name>.md of the Plan → Review → Einarbeiten → Umsetzen → Verify workflow, run by hand or as a sol loop) this session works on; the board reads their version headers and .review.md/.verify.md siblings itself. Plans you write, edit or exit plan mode with are tracked automatically. untrack_plans removes them.',
  'add_artifacts: links that matter for the current work ({label, href}): claude.ai artifacts, PRs, docs. remove_artifacts: by href.',
  'open_decisions: every question you put to the user that needs an answer, however small, even a yes/no, wherever it sits in your reply. The user answers from the board, so make each one self-contained: {question, context, options, recommended, weight}. context: 1-3 sentences on why it comes up now and what depends on it. options: 2-4 short answers, each as a string or {label, note} where note says in one short line what picking it does. recommended: the option you would pick. weight: blocking (work stops until answered), important (shapes the result) or optional (a nicety; a default applies).',
  'Questions you ask with AskUserQuestion land on the board by themselves and close with the answer. edit_decisions: sharpen an open question by id (context, options, recommended, weight), e.g. after explaining it.',
  'decide: close a decision by id once the user has answered, with the answer in a few words (it stays in the decision log the user reads later).',
  'Use todos in place of writing task lists in your reply whenever the work takes 3+ distinct steps. add_todos: one action per item. start_todo: the todo id you are working on now; exactly one at a time. done_todos / remove_todos: todo ids. Mark a todo done only after the work, including any verification, is actually done. clear_done: drop finished todos when a new topic starts.',
  'The current board, with ids, is at the end of your system prompt.',
].join(' ')

const strings = { type: 'array', items: { type: 'string' } }
const WEIGHT = { type: 'string', enum: ['blocking', 'important', 'optional'] }
// An answer: a plain label, or a label with a one-line note on what it does
const OPTIONS = {
  type: 'array',
  items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, note: { type: 'string' } }, required: ['label'] }] },
}
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
            properties: { question: { type: 'string' }, context: { type: 'string' }, options: OPTIONS, recommended: { type: 'string' }, weight: WEIGHT },
            required: ['question'],
          },
        ],
      },
    },
    edit_decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, question: { type: 'string' }, context: { type: 'string' }, options: OPTIONS, recommended: { type: 'string' }, weight: WEIGHT },
        required: ['id'],
      },
    },
    decide: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] },
    },
  },
}

export type OptionInput = string | { label: string; note?: string }

export type QuestionInput = { question: string; context?: string; options?: OptionInput[]; recommended?: string; weight?: Weight }

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

export type Board = { thread: Thread | null; topic: Topic | null; todos: Todo[]; decisions: Decision[]; artifacts: Artifact[]; log: LogEntry[]; trail?: TopicMark[] }

// The next id for a prefix: one past the highest in use
const nextId = (prefix: string, ids: string[]) =>
  prefix + (Math.max(0, ...ids.map(id => Number(id.slice(prefix.length)) || 0)) + 1)

// The fields of a question as the board keeps them: trimmed, empty ones left out
function questionFields(q: Partial<QuestionInput>): Partial<Omit<Decision, 'id' | 'at'>> {
  const given = (q.options ?? [])
    .map(o => (typeof o === 'string' ? { label: o.trim(), note: '' } : { label: o.label.trim(), note: o.note?.trim() ?? '' }))
    .filter(o => o.label)
    .slice(0, 4)
  const options = given.map(o => o.label)
  const notes = given.map(o => o.note)
  return {
    ...(q.question?.trim() && { text: q.question.trim() }),
    ...(q.context?.trim() && { context: q.context.trim() }),
    ...(options.length && { options }),
    // Notes only when at least one option has one; editing the options replaces them
    ...(q.options && { notes: notes.some(Boolean) ? notes : undefined }),
    ...(q.recommended?.trim() && { recommended: q.recommended.trim() }),
    ...(q.weight && { weight: q.weight }),
  }
}

export function applyUpdate(board: Board, change: Update, now = Date.now()): Board {
  let { thread: th, topic: tp, todos: t, decisions: d, artifacts: a, log: l } = board
  let trailOut = board.trail ?? []
  // The thread is the stable anchor: set once, replaced only with a reason
  if (change.thread && (!th || change.thread.why?.trim())) {
    th = { title: change.thread.title.trim(), goal: change.thread.goal.trim() }
  }
  if (change.topic) {
    const title = change.topic.title.trim()
    // A new subject starts a new topic; the old one joins the trail. A changed summary keeps its time.
    const isNew = !tp || tp.title !== title
    if (tp && isNew) trailOut = [...trailOut, { title: tp.title, at: tp.at ?? now }].slice(-8)
    tp = {
      title,
      summary: change.topic.summary.trim(),
      points: (change.topic.points ?? []).map(p => p.trim()).filter(Boolean).slice(0, 5),
      at: isNew ? now : (tp?.at ?? now),
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
  if (change.start_todo) {
    t = t.map(x => (x.id === change.start_todo ? { ...x, isActive: true, startedAt: x.isActive ? (x.startedAt ?? now) : now } : { ...x, isActive: false }))
  }
  t = t.map(x => (x.isDone && x.isActive ? { ...x, isActive: false } : x))
  // A decision closes into the log with its answer, so the why stays findable
  const answers = new Map((change.decide ?? []).map(x => [x.id, x.answer.trim()]))
  l = [
    ...l,
    ...d.filter(x => decided.has(x.id)).map(x => ({ text: x.text, answer: answers.get(x.id) ?? '', at: now, ...(x.at !== undefined && { openedAt: x.at }) })),
  ].slice(-30)
  d = d.filter(x => !decided.has(x.id))
  return { thread: th, topic: tp, todos: t, decisions: d, artifacts: a.slice(-12), log: l, trail: trailOut }
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
    const notes = (q.options ?? []).map(o => o.description?.trim() ?? '')
    const recommended = labels.find(l => /\((recommended|empfohlen)\)/i.test(l))
    const id = nextId('d', next.map(x => x.id))
    next = [
      ...next,
      {
        id,
        text: q.question.trim(),
        ...(q.header && { context: q.header }),
        ...(labels.length && { options: labels.map(l => l.replace(/\s*\((recommended|empfohlen)\)/i, '')) }),
        ...(notes.some(Boolean) && { notes }),
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
  trail: await read($, trail),
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

// What kind of link an artifact is, from its URL: a claude.ai artifact, a pull request, or a document
export function artifactKind(href: string): { kind: 'artifact' | 'pr' | 'doc'; glyph: string } {
  if (/claude\.ai\/(code\/)?artifact\//.test(href)) return { kind: 'artifact', glyph: '◇' }
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(href)) return { kind: 'pr', glyph: '⑂' }
  return { kind: 'doc', glyph: '▤' }
}

// "claude.ai", "github · PR #412", or the path's file name for a local file
export function hostOf(href: string): string {
  const pr = href.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/)
  if (pr) return `github · ${pr[1]} #${pr[2]}`
  const m = href.match(/^[a-z]+:\/\/([^/]+)/i)
  if (m && !href.startsWith('file:')) return m[1]!.replace(/^www\./, '')
  return href.split('/').filter(Boolean).slice(-2, -1)[0] ?? href
}

// In Herdr the board is the sidebar tab of the herdr plugin (mods/fokus); the terminal pane stays closed
const open = async ($: EngineInterface) => (herdr ? showInHerdr($) : void (await $.ui.open({ id: PANE, title: TITLE })))

// The footer switch: closes the board when it is open, else refreshes and opens it
const toggle = async ($: EngineInterface) => {
  if (herdr) return showInHerdr($)
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

// ── Griffe: prompts the person sends again and again, one list across sessions ──

export const DEFAULT_GRIFFE: Griff[] = [
  { label: 'Plan komplett umsetzen', text: 'Setze {plan} komplett um.' },
  { label: 'Simplify', text: '/simplify' },
  { label: 'Verify', text: '/workflow:plan-verify {plan}' },
  { label: 'Sol-Verify', text: 'sol loop verify {plan}' },
  { label: 'Sol-Loop Plan', text: 'sol loop plan {plan}' },
  { label: 'Review einarbeiten', text: '/workflow:plan-integrate-review {plan}' },
  { label: 'Code-Review', text: '/code-review high' },
  { label: 'Plan-Status', text: '/workflow:plan-status' },
]

// A new Griff from what the person typed: the label is the text, shortened
export function addGriff(list: Griff[], text: string, label?: string): Griff[] {
  const clean = text.trim()
  if (!clean || list.some(g => g.text === clean)) return list
  const cut = clean.slice(0, 28)
  const name = label?.trim() || (clean.length > 28 ? (cut.lastIndexOf(' ') > 10 ? cut.slice(0, cut.lastIndexOf(' ')) : cut.slice(0, 27)) + '…' : clean)
  return [...list, { label: name, text: clean }].slice(0, 24)
}

// {plan} becomes the open plan's path (the newest one not yet verified); without one it stays for the person to fill
export const fillPlan = (text: string, plan: string | null) => (plan ? text.replaceAll('{plan}', plan) : text)

async function changeGriffe($: EngineInterface, fn: (list: Griff[]) => Griff[]) {
  await update($, griffe, fn)
  try {
    await $.store.set(GRIFFE_KEY, await read($, griffe))
  } catch {}
}

// The plan a Griff's {plan} points at, relative to the session folder
async function openPlan($: EngineInterface): Promise<string | null> {
  const codeEdit = await read($, lastCodeEditAt)
  const open = (await read($, planStatus)).filter(s => stageOf(s, codeEdit).step !== 'done')
  const last = open.at(-1) ?? (await read($, planStatus)).at(-1)
  return last ? relative($, last.path) : null
}

async function putGriff($: EngineInterface, g: Griff) {
  await put($, fillPlan(g.text, await openPlan($)))
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
  const cwd = (await $.session.cwd().catch(() => '')).replace(/\/$/, '') + '/'
  return path.startsWith(cwd) ? path.slice(cwd.length) : path
}

// The mode rides on every classic hook's input; keep the latest
const noteMode = async ($: EngineInterface, value: string | undefined) => {
  if (value && value !== (await read($, mode))) await update($, mode, () => value)
}

// ── Resume: the board is kept per session id, which --resume keeps ──────────────

// The saved boards with this session's put in, newest first, at most SAVED_SESSIONS
export function keepBoard(all: Record<string, SavedBoard>, id: string, board: SavedBoard): Record<string, SavedBoard> {
  const entries = Object.entries({ ...all, [id]: board }).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, SAVED_SESSIONS))
}

// The id the board is kept under, from the classic SessionStart event: at session.start a resumed
// session's $.session.id() is not yet the transcript's. Nothing is saved before it is known, so an
// empty board never overwrites the saved one. (Module state: a reload waits for the next start.)
let boardId: string | null = null
// Whether that start was a --resume (or fork), whose board session.start brings back
let isResumed = false
// The last board saved, to tell whether anything changed
let lastSaved = ''

// Saves the board under this session's id when it changed. An empty board is never saved: there
// is nothing to bring back, and at the session's end its state is already gone (saving then would
// overwrite the board a --resume should get back).
async function saveBoard($: EngineInterface) {
  if (!boardId) return
  const board = await readBoard($)
  if (isEmpty(board) && (await read($, plans)).length === 0) return
  const body = JSON.stringify({ ...board, plans: await read($, plans) })
  if (body === lastSaved) return
  lastSaved = body
  const all = ((await $.store.get(BOARDS_KEY)) ?? {}) as Record<string, SavedBoard>
  await $.store.set(BOARDS_KEY, keepBoard(all, boardId, { at: Date.now(), ...board, plans: await read($, plans) }))
}

// A resumed session (same id) gets its board back; a new one starts empty
async function restoreBoard($: EngineInterface, id: string) {
  if (!isEmpty(await readBoard($))) return
  const all = ((await $.store.get(BOARDS_KEY)) ?? {}) as Record<string, SavedBoard>
  const saved = all[id]
  if (!saved) return
  await update($, thread, () => saved.thread)
  await update($, topic, () => saved.topic)
  await update($, decisions, () => saved.decisions)
  await update($, todos, () => saved.todos)
  await update($, artifacts, () => saved.artifacts)
  await update($, log, () => saved.log)
  await update($, plans, () => saved.plans)
  await update($, trail, () => saved.trail ?? [])
}

// "Review #2 · Sol · gegen v3 · 1 kritisch", or null before the first review
export function reviewLine(s: PlanStatus): string | null {
  if (s.latestReview === null) return null
  return [
    `Review #${s.latestReview}`,
    s.reviewBy,
    s.reviewedVersion !== null && s.reviewedVersion !== undefined && `gegen v${s.reviewedVersion}`,
    s.latestReview > (s.integratedReview ?? 0) ? findingsText(s.findings) || 'offen' : 'eingearbeitet',
  ]
    .filter(Boolean)
    .join(' · ')
}

// ── Herdr: the board as a file the herdr plugin's sidebar (mods/fokus) shows live ──────
//
//   this mod ──every second, when changed──► ~/.local/state/fokusboard/<terminal>.json ──► Herdr
//   this mod ◄──intents with `at`, newest last── ~/.local/state/fokusboard/<terminal>.inbox.jsonl ◄── Herdr
//
// Set in session.start when Claude runs in a Herdr terminal (HC_TERMINAL_ID); null elsewhere.
let herdr: { terminal: string; dir: string; seen: number; last: string } | null = null

// What a click in the Herdr sidebar asks for; the board does it here, so its logic lives in one place
export type Intent =
  | { do: 'put'; text: string }
  | { do: 'answer'; id: string; option: string }
  | { do: 'reply' | 'explain' | 'dismiss'; id: string }
  | { do: 'ask'; ids?: string[] }
  | { do: 'griff.put' | 'griff.remove'; index: number }
  | { do: 'griff.add'; text: string; label?: string }
  | { do: 'todos.clearDone' | 'refresh' }

// Everything the sidebar draws, with each plan's stage and next steps worked out already
async function snapshot($: EngineInterface, ended = false) {
  const board = await readBoard($)
  const status = await read($, planStatus)
  const codeEdit = await read($, lastCodeEditAt)
  const plansOut = []
  const plan = await openPlan($)
  for (const s of status) {
    const stage = stageOf(s, codeEdit)
    const rel = await relative($, s.path)
    const base = s.path.replace(/\.md$/, '')
    plansOut.push({
      path: s.path,
      rel,
      name: s.name,
      version: s.planVersion,
      stage,
      steps: pipeline(stage.step),
      next: nextSteps(s, stage, rel),
      review: reviewLine(s),
      latestReview: s.latestReview,
      reviewedVersion: s.reviewedVersion ?? null,
      reviewBy: s.reviewBy ?? null,
      verify: s.verifyResult ? { result: s.verifyResult, version: s.verifiedVersion } : null,
      files: [
        { label: s.planVersion ? `Plan v${s.planVersion}` : 'Plan', path: s.path, exists: s.exists },
        { label: s.latestReview ? `Review #${s.latestReview}` : 'Review', path: base + '.review.md', exists: s.hasReview },
        { label: 'Verify', path: base + '.verify.md', exists: s.hasVerify },
      ],
    })
  }
  return {
    v: 1,
    terminal: herdr?.terminal ?? null,
    cwd: await $.session.cwd().catch(() => null),
    ended,
    mode: await read($, mode),
    ...board,
    plans: plansOut,
    griffe: (await read($, griffe)).map(g => ({ ...g, text: fillPlan(g.text, plan) })),
  }
}

// Writes the snapshot when it changed (the sidebar watches the folder, so a write is a redraw)
async function publishToHerdr($: EngineInterface, ended = false) {
  if (!herdr) return
  const body = JSON.stringify(await snapshot($, ended))
  if (body === herdr.last) return
  herdr.last = body
  // updatedAt rides outside the comparison, so an unchanged board is not rewritten every second
  await $.fs.write(`${herdr.dir}/${herdr.terminal}.json`, body.replace(/^\{/, `{"updatedAt":${Date.now()},`))
}

// Marks the last published board as ended (the session's state is already gone at its end)
async function endInHerdr($: EngineInterface) {
  if (!herdr?.last) return
  const board = JSON.parse(herdr.last) as Record<string, unknown>
  await $.fs.write(`${herdr.dir}/${herdr.terminal}.json`, JSON.stringify({ updatedAt: Date.now(), ...board, ended: true }))
}

// The intents the sidebar wrote since the last read, oldest first
export function newIntents(text: string, seen: number): { at: number; intent: Intent }[] {
  const out: { at: number; intent: Intent }[] = []
  for (const line of text.split('\n')) {
    try {
      const x = JSON.parse(line) as { at?: number } & Intent
      if (typeof x.at === 'number' && x.at > seen && typeof x.do === 'string') out.push({ at: x.at, intent: x })
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at)
}

async function handle($: EngineInterface, x: Intent) {
  const find = async (id: string) => (await read($, decisions)).find(d => d.id === id)
  switch (x.do) {
    case 'put':
      return put($, x.text)
    case 'answer': {
      const d = await find(x.id)
      return d && put($, `Zu „${d.text}“: ${x.option}`)
    }
    case 'reply': {
      const d = await find(x.id)
      return d && replyTo($, d)
    }
    case 'explain': {
      const d = await find(x.id)
      return d && explain($, d)
    }
    case 'dismiss': {
      const d = await find(x.id)
      return d && dismiss($, d)
    }
    case 'ask': {
      const all = await read($, decisions)
      return askAbout($, x.ids?.length ? all.filter(d => x.ids!.includes(d.id)) : all)
    }
    case 'griff.put': {
      const g = (await read($, griffe))[x.index]
      return g && putGriff($, g)
    }
    case 'griff.add':
      return changeGriffe($, list => addGriff(list, x.text, x.label))
    case 'griff.remove':
      return changeGriffe($, list => list.filter((_, i) => i !== x.index))
    case 'todos.clearDone':
      return update($, todos, list => list.filter(t => !t.isDone))
    case 'refresh':
      return refresh($)
  }
}

// One beat of the bridge: carry out new clicks, then publish the board
async function herdrTick($: EngineInterface) {
  if (!herdr) return
  const inbox = await readOr($, `${herdr.dir}/${herdr.terminal}.inbox.jsonl`)
  for (const { at, intent } of newIntents(inbox.text, herdr.seen)) {
    herdr.seen = at
    try {
      await handle($, intent)
    } catch {}
  }
  await publishToHerdr($)
}

// Shows the Fokus tab of Herdr's right panel (layout ids from the herdr plugin's main-filetree layout)
async function showInHerdr($: EngineInterface) {
  try {
    await $.process.run(['herdr-app', 'do', 'layout.select', JSON.stringify({ stack: 'panel-body', child: 'fokus' })])
    await $.process.run(['herdr-app', 'do', 'layout.show', JSON.stringify({ id: 'panel' })])
  } catch {}
}

const WEIGHTS: { weight: Weight; label: string; bullet: string; color?: string }[] = [
  { weight: 'blocking', label: 'Blockiert', bullet: '●', color: 'error' },
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
    // The person's Griffe are one list for every session; the board comes back only to a resumed session
    if ((await read($, griffe)).length === 0) {
      try {
        const saved = (await $.store.get(GRIFFE_KEY)) as Griff[] | undefined
        await update($, griffe, () => (Array.isArray(saved) ? saved : DEFAULT_GRIFFE))
      } catch {
        await update($, griffe, () => DEFAULT_GRIFFE)
      }
    }
    // classic.SessionStart, which sets boardId, runs before this hook
    if (boardId && isResumed) {
      try {
        await restoreBoard($, boardId)
        if ((await read($, plans)).length > 0) await refresh($)
      } catch {}
    }
    void $.clock.every(SAVE_MS, async () => {
      try {
        await saveBoard($)
      } catch {}
    })
    // In a Herdr terminal the board also goes to the herdr plugin's sidebar
    const terminal = await $.env.get('HC_TERMINAL_ID')
    const home = await $.env.get('HOME')
    // Clicks from before this start were meant for an earlier session
    herdr = terminal && home ? { terminal, dir: `${home}/.local/state/fokusboard`, seen: Date.now(), last: '' } : null
    if (herdr) void $.clock.every(HERDR_MS, () => herdrTick($))
    return next(e)
  })

  // The sidebar greys the board out once the session is gone
  on('session.end', async ($, e, next) => {
    try {
      await endInHerdr($)
    } catch {}
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
    const text = describeBoard(await readBoard($), await read($, planStatus), await read($, mode), await read($, lastCodeEditAt))
    return { sections: [...sections, { id: 'fokusboard:board', text, scope: 'session' }] }
  })

  // The transcript's id arrives here, also for --resume, before session.start (which restores the board)
  on('classic.SessionStart', async ($, e, next) => {
    lastSaved = ''
    boardId = e.session_id
    isResumed = e.source === 'resume' || e.source === 'fork'
    return next(e)
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
    await update($, trail, () => board.trail ?? [])
    for (const p of change.track_plans ?? []) await maybeTrack($, p, true)
    if (change.untrack_plans?.length) {
      const gone = new Set(await Promise.all(change.untrack_plans.map(async p => planOf(await absolute($, p)))))
      await update($, plans, list => list.filter(p => !gone.has(p)))
    }
    await refresh($)
    try {
      await saveBoard($)
    } catch {}
    const status = await read($, planStatus)
    // Opens by itself the first time something lands on an empty board (in Herdr the Fokus button counts instead)
    if (!herdr && isEmpty(before) && (!isEmpty(board) || status.length > 0)) await open($)
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
    const ran = await next(e)
    if (e.agentId || !('result' in ran) || ran.isError) return ran
    let path: string | undefined = target
    if (e.tool === 'ExitPlanMode') path = (ran.result as { filePath?: string } | undefined)?.filePath
    if (!path) return ran
    const wasEmpty = (await read($, plans)).length === 0
    const tracked = e.tool === 'ExitPlanMode' ? await maybeTrack($, path, true) : await maybeTrack($, path)
    if (!path.endsWith('.md')) await update($, lastCodeEditAt, () => Date.now())
    if (tracked || isPlanPath(path) || (await read($, plans)).length > 0) await refresh($)
    if (tracked && wasEmpty && !herdr) await open($)
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
    // The mobile app draws no text field yet; there Griffe can be used but not added
    const Input = 'Input' in elements ? elements.Input : undefined
    // The terminal frames the whole board; inside it, one cell of padding on every side
    const isTerminal = e.surface === 'terminal'
    const frame = isTerminal ? 2 : 0
    const inner = Math.max(10, e.props.bodyColumns - 2 - frame)
    const { thread: th, topic: tp, todos: allTodos, decisions: allDecisions, artifacts: allArtifacts, trail: topicTrail = [] } = await readBoard($)
    const status = await read($, planStatus)
    const ownGriffe = await read($, griffe)
    const isDoneHidden = await read($, hideDone)
    const plan = await openPlan($)
    const now = Date.now()
    const doneCount = allTodos.filter(t => t.isDone).length

    // Section label: dim uppercase, the rule to the pane's edge (the terminal counts cells; elsewhere it is clipped)
    const header = (title: string, right = '', width = inner) => (
      <Box flexDirection="row" width={width} marginBottom={1}>
        <Box flexShrink={0}>
          <Text bold>{title.toUpperCase() + ' '}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate">
            {'─'.repeat(isTerminal ? Math.max(0, width - title.length - 1 - (right ? right.length + 1 : 0)) : 200)}
          </Text>
        </Box>
        {right && (
          <Box flexShrink={0}>
            <Text dimColor>{' ' + right}</Text>
          </Box>
        )}
      </Box>
    )
    // A row whose glyph sits in a fixed column, so wrapped lines indent under the text
    const row = (glyph: string, text: string, opts: { color?: string; isDim?: boolean; isBold?: boolean; right?: string; strike?: boolean } = {}) => (
      <Box flexDirection="row" alignItems="flex-start" width={inner}>
        <Box width={3} flexShrink={0}>
          <Text color={opts.color} dimColor={opts.isDim}>
            {glyph}
          </Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor={opts.isDim} bold={opts.isBold} strikethrough={opts.strike} wrap="wrap">
            {text}
          </Text>
        </Box>
        {opts.right && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{opts.right}</Text>
          </Box>
        )}
      </Box>
    )
    const since = (at?: number) => (at ? ago(now - at).replace(/^vor /, 'seit ') : '')

    // Head: what the conversation is about, one dot per topic (the current one in the accent)
    const dots = [...topicTrail.map(() => '•'), ...(tp ? ['•'] : [])].slice(-5)
    const head = (th || tp) && (
      <Box flexDirection="row" width={inner} marginBottom={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text bold wrap="wrap">
            {th?.title ?? tp?.title}
          </Text>
        </Box>
        {dots.length > 1 && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{dots.slice(0, -1).join('')}</Text>
            <Text color="claude">•</Text>
          </Box>
        )}
      </Box>
    )

    // Jetzt: the current topic, not boxed in
    const nowBlock = tp ? (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        <Box flexDirection="row" width={inner}>
          <Box flexGrow={1}>
            <Text color="claude">◉ JETZT</Text>
          </Box>
          <Text dimColor>{since(tp.at)}</Text>
        </Box>
        <Text bold wrap="wrap">
          {tp.title}
        </Text>
        <Text dimColor wrap="wrap">
          {tp.summary}
        </Text>
        {tp.points.map(p => row(' ·', p, { isDim: true }))}
      </Box>
    ) : (
      <Box width={inner} marginBottom={1}>
        <Text dimColor wrap="wrap">
          Noch kein Thema. Claude setzt es, sobald das Gespräch eins hat.
        </Text>
      </Box>
    )

    // One open question: kind and age, the question and its context, one row per answer with its note, then the quiet actions
    const order = { blocking: 0, important: 1, optional: 2 } as const
    const questions = [...allDecisions].sort((x, y) => order[x.weight ?? 'important'] - order[y.weight ?? 'important'])
    const questionCard = (d: Decision) => {
      const w = WEIGHTS.find(x => x.weight === (d.weight ?? 'important'))!
      const opts = (d.options ?? []).map((o, i) => ({ o, note: d.notes?.[i] ?? '' }))
      return (
        <Box flexDirection="column" width={inner} marginBottom={1}>
          <Box flexDirection="row" width={inner}>
            <Box flexGrow={1}>
              <Text color={w.color} dimColor={!w.color}>
                {w.bullet + ' ' + w.label.toUpperCase()}
              </Text>
            </Box>
            {d.at !== undefined && <Text dimColor>{ago(now - d.at)}</Text>}
          </Box>
          <Text bold wrap="wrap">
            {d.text}
          </Text>
          {d.context && (
            <Text dimColor wrap="wrap">
              {d.context}
            </Text>
          )}
          {opts.map(({ o, note }, i) => (
            <Box flexDirection="column" width={inner} paddingLeft={2}>
              <Box flexDirection="row" width={inner - 2}>
                <Box flexGrow={1} flexShrink={1}>
                  <Button key={`opt:${d.id}:${i}`} label={o} plain={o !== d.recommended || undefined} onPress={() => put($, `Zu „${d.text}“: ${o}`)} />
                </Box>
                {o === d.recommended && <Text color="claude">{' Empfohlen'}</Text>}
              </Box>
              {note && (
                <Box paddingLeft={1}>
                  <Text dimColor wrap="wrap">
                    {note}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
          {d.recommended && !d.options?.includes(d.recommended) && <Text dimColor wrap="wrap">{'Empfehlung: ' + d.recommended}</Text>}
          <Box flexDirection="row" flexWrap="wrap" gap={2}>
            <Button key={'reply:' + d.id} label="Eigene Antwort" plain dimColor onPress={() => replyTo($, d)} />
            <Button key={'explain:' + d.id} label="Erklären" plain dimColor onPress={() => explain($, d)} />
          </Box>
        </Box>
      )
    }

    // Todos: every one stays; the header carries the bar and the count; done ones can be hidden
    const bar = (done: number, total: number) => {
      const full = total ? Math.round((done / total) * 10) : 0
      return (
        <Text>
          <Text color="success">{'▰'.repeat(full)}</Text>
          <Text dimColor>{'▱'.repeat(10 - full)}</Text>
        </Text>
      )
    }
    const shownTodos = isDoneHidden ? allTodos.filter(t => !t.isDone) : allTodos
    const todoBlock = allTodos.length > 0 && (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        <Box flexDirection="row" width={inner} marginBottom={1}>
          <Text bold>{'TODOS '}</Text>
          <Box flexGrow={1}>{bar(doneCount, allTodos.length)}</Box>
          <Text dimColor>{`${doneCount}/${allTodos.length}`}</Text>
        </Box>
        {shownTodos.map(t =>
          t.isDone
            ? row('✓', t.text, { color: 'success', isDim: true, strike: true })
            : t.isActive
              ? row('▸', t.text, { color: 'suggestion', isBold: true, right: since(t.startedAt) })
              : row('○', t.text, { isDim: true }),
        )}
        {doneCount > 0 && (
          <Button
            key="toggle-done"
            label={isDoneHidden ? `${doneCount} erledigte einblenden` : 'Erledigte ausblenden'}
            plain
            dimColor
            onPress={() => update($, hideDone, v => !v)}
          />
        )}
      </Box>
    )

    // Plans as a small file tree: plan and version, its review and verify beneath; a click opens the file
    const fileLink = (href: string, label: string) => {
      if (e.surface === 'terminal') {
        return (
          <Text>
            <Link href={'file://' + href} label={label} />
          </Text>
        )
      }
      return <Button key={'open:' + href} label={label} plain onPress={() => openFile($, href)} />
    }
    const treeRow = (glyph: string, href: string, label: string, right: string, isSub = false) => (
      <Box flexDirection="row" width={inner} paddingLeft={isSub ? 2 : 0}>
        <Box width={3} flexShrink={0}>
          <Text dimColor>{glyph}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {fileLink(href, label)}
        </Box>
        {right && <Text dimColor>{' ' + right}</Text>}
      </Box>
    )
    const planTree = status.length > 0 && (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        {header('Pläne')}
        {status.map(s => {
          const base = s.path.replace(/\.md$/, '')
          return (
            <Box flexDirection="column" width={inner}>
              {treeRow('▤', s.path, s.name + '.md', s.planVersion ? `v${s.planVersion}` : '')}
              {s.hasReview &&
                treeRow('└', base + '.review.md', 'review.md', [s.latestReview && `#${s.latestReview}`, s.reviewedVersion && `gegen v${s.reviewedVersion}`].filter(Boolean).join(' · '), true)}
              {s.hasVerify &&
                treeRow('└', base + '.verify.md', 'verify.md', [s.verifiedVersion && `v${s.verifiedVersion}`, s.verifyResult].filter(Boolean).join(' · '), true)}
            </Box>
          )
        })}
      </Box>
    )

    const artifactBlock = allArtifacts.length > 0 && (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        {header('Artefakte')}
        {allArtifacts.map(a => (
          <Box flexDirection="row" alignItems="flex-start" width={inner}>
            <Box width={3} flexShrink={0}>
              <Text dimColor>{artifactKind(a.href).glyph}</Text>
            </Box>
            <Box flexDirection="column" flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-middle">
                <Link href={a.href} label={a.label} />
              </Text>
              <Text dimColor wrap="truncate">
                {hostOf(a.href)}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    )

    // Griffe: prompts sent again and again; a click puts one in the prompt box
    const griffBlock = (
      <Box flexDirection="column" width={inner} marginBottom={1}>
        {header('Griffe')}
        <Box flexDirection="row" flexWrap="wrap" gap={1} width={inner}>
          {ownGriffe.map((g, i) => (
            <Button key={'griff:' + i} label={g.label} onPress={() => put($, fillPlan(g.text, plan))} />
          ))}
        </Box>
        {Input && (
          <Box width={inner} marginTop={1}>
            <Input
              key={'griff-input-' + ownGriffe.length}
              placeholder="+ Griff hinzufügen…"
              submitLabel="hinzufügen"
              onSubmit={(text: string) => changeGriffe($, list => addGriff(list, text))}
            />
          </Box>
        )}
      </Box>
    )

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
        {head}
        {nowBlock}
        {questions.length > 0 && (
          <Box flexDirection="row" width={inner}>
            <Box flexGrow={1}>{header('Fragen', '', questions.length > 1 ? inner - 18 : inner)}</Box>
            {questions.length > 1 && <Button key="ask-all" label=" alle beantworten →" hotkey="a" plain dimColor onPress={() => askAbout($, allDecisions)} />}
          </Box>
        )}
        {questions.map(questionCard)}
        {todoBlock}
        {planTree}
        {artifactBlock}
        {griffBlock}
      </Box>
    )
  })
}
