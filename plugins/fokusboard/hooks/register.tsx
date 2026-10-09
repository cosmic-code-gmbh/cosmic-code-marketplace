// Fokusboard: the current topic, the plan workflow, artifacts, open decisions and todos in a side pane.
// Board logic (todos, decisions, the Stop nudge) follows sirkitree/pinboard (MIT).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact, Decision, PlanStatus, Step, Todo, Topic } from '../types'

const PANE = 'fokusboard'
const TITLE = 'Fokusboard'
const TOOL = 'mcp__fokusboard__update'
const POLL_MS = 5000

const topic = atom({ plugin: 'fokusboard', key: 'topic' } as const, null as Topic | null)
const decisions = atom({ plugin: 'fokusboard', key: 'decisions' } as const, [] as Decision[])
const todos = atom({ plugin: 'fokusboard', key: 'todos' } as const, [] as Todo[])
const artifacts = atom({ plugin: 'fokusboard', key: 'artifacts' } as const, [] as Artifact[])
const mode = atom({ plugin: 'fokusboard', key: 'mode' } as const, null as string | null)
const plans = atom({ plugin: 'fokusboard', key: 'plans' } as const, [] as string[])
const planStatus = atom({ plugin: 'fokusboard', key: 'planStatus' } as const, [] as PlanStatus[])
const lastCodeEditAt = atom({ plugin: 'fokusboard', key: 'lastCodeEditAt' } as const, 0)

const DESCRIPTION = [
  "Keep the user's Fokusboard current: a sidebar that stays in view while the transcript scrolls, showing the current topic, the plan workflow, artifacts, open decisions and the task list.",
  'topic: set it when a conversation gets a subject, and update it whenever the subject shifts or your understanding changes materially (a decision made, a cause found, a plan agreed).',
  'topic.title: 2-6 words. topic.summary: 1-3 short sentences on where things stand now, not a history. topic.points: up to 5 terse key facts or constraints worth keeping in view.',
  "Write the topic in the user's language.",
  'track_plans: paths of plan files (docs/**/<name>.md of the Plan → Review → Einarbeiten → Verify workflow) this session works on; the board reads their version headers and .review.md/.verify.md siblings itself. Plans you write, edit or exit plan mode with are tracked automatically. untrack_plans removes them.',
  'add_artifacts: links that matter for the current work ({label, href}): claude.ai artifacts, PRs, docs. remove_artifacts: by href.',
  'Any question you end a reply on that needs the user to answer goes in open_decisions, however small, even a single yes/no.',
  'Use todos in place of writing task lists in your reply whenever the work takes 3+ distinct steps.',
  'add_todos: one action per item. start_todo: the todo id you are working on now; exactly one at a time. done_todos / remove_todos: todo ids.',
  'Mark a todo done only after the work, including any verification, is actually done.',
  'decide: close a decision by id once the user has answered. clear_done: drop finished todos when a new topic starts.',
  'The current board, with ids, is at the end of your system prompt.',
].join(' ')

const strings = { type: 'array', items: { type: 'string' } }
const SCHEMA = {
  type: 'object',
  properties: {
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

export type Board = { topic: Topic | null; todos: Todo[]; decisions: Decision[]; artifacts: Artifact[] }

// The next id for a prefix: one past the highest in use
const nextId = (prefix: string, ids: string[]) =>
  prefix + (Math.max(0, ...ids.map(id => Number(id.slice(prefix.length)) || 0)) + 1)

export function applyUpdate(board: Board, change: Update): Board {
  let { topic: tp, todos: t, decisions: d, artifacts: a } = board
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
  d = d.filter(x => !decided.has(x.id))
  return { topic: tp, todos: t, decisions: d, artifacts: a.slice(-12) }
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
  if (JSON.stringify(before) !== JSON.stringify(next)) await update($, planStatus, () => next)
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
  return true
}

// ── Board text for the system prompt ────────────────────────────────────────

export function describeBoard(board: Board, status: PlanStatus[] = [], currentMode: string | null = null, lastCodeEdit = 0): string {
  const lines = ['Fokusboard now:']
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
  topic: await read($, topic),
  todos: await read($, todos),
  decisions: await read($, decisions),
  artifacts: await read($, artifacts),
})

const isEmpty = (b: Board) => !b.topic && b.todos.length + b.decisions.length + b.artifacts.length === 0

export function summarize(change: Update): string {
  const parts = [
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

// Opens a plan file in the Mac's default app for Markdown
async function openFile($: EngineInterface, path: string) {
  const { exitCode, stderr } = await $.process.run(['open', path])
  if (exitCode !== 0) await $.ui.toast(`Konnte ${path.split('/').at(-1)} nicht öffnen: ${stderr.trim()}`)
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
    await update($, topic, () => board.topic)
    await update($, todos, () => board.todos)
    await update($, decisions, () => board.decisions)
    await update($, artifacts, () => board.artifacts)
    for (const p of change.track_plans ?? []) await maybeTrack($, p, true)
    if (change.untrack_plans?.length) {
      const gone = new Set(await Promise.all(change.untrack_plans.map(async p => planOf(await absolute($, p)))))
      await update($, plans, list => list.filter(p => !gone.has(p)))
    }
    await refresh($)
    const status = await read($, planStatus)
    // Opens by itself the first time something lands on an empty board
    if (isEmpty(before) && (!isEmpty(board) || status.length > 0)) await open($)
    return { result: describeBoard(board, status, await read($, mode), await read($, lastCodeEditAt)) }
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
    const { topic: tp, todos: allTodos, decisions: allDecisions, artifacts: allArtifacts } = await readBoard($)
    const status = await read($, planStatus)
    const currentMode = await read($, mode)
    const codeEdit = await read($, lastCodeEditAt)
    const doneCount = allTodos.filter(t => t.isDone).length

    const header = (title: string, count: string, color?: string) => (
      <Text bold color={color}>
        {title} <Text dimColor>{count}</Text>
      </Text>
    )
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
    const card = inner - 4
    const topicCard = tp ? (
      <Box flexDirection="column" width={inner} borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="row" alignItems="flex-start" width={card}>
          <Box width={2} flexShrink={0}>
            {Svg ? <Svg source={FOCUS_ICON} alt="Thema" width={15} height={15} /> : <Text color="claude">◎</Text>}
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text bold color="claude" wrap="wrap">
              {tp.title}
            </Text>
          </Box>
        </Box>
        <Box width={card}>
          <Text wrap="wrap">{tp.summary}</Text>
        </Box>
        {tp.points.length > 0 && <Text> </Text>}
        {tp.points.map(p => (
          <Box flexDirection="row" alignItems="flex-start" width={card}>
            <Box width={2} flexShrink={0}>
              <Text color="claude">›</Text>
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              <Text dimColor wrap="wrap">
                {p}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    ) : (
      <Box width={inner} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>Noch kein Thema. Claude setzt es, sobald das Gespräch eins hat.</Text>
      </Box>
    )

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

    // Open work first; finished plans sink to the bottom
    const sorted = [...status].sort((a, b) => Number(stageOf(a, codeEdit).step === 'done') - Number(stageOf(b, codeEdit).step === 'done'))
    const showWorkflow = isPlanMode || status.length > 0

    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        {topicCard}
        <Text> </Text>

        {showWorkflow && (
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            {header('Plan-Workflow', status.length ? String(status.length) : '')}
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

        {allArtifacts.length > 0 && header('Artefakte', String(allArtifacts.length))}
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

        {header('Offene Entscheidungen', allDecisions.length ? String(allDecisions.length) : '', allDecisions.length ? 'warning' : undefined)}
        {allDecisions.length === 0 && empty('Nichts offen.')}
        {allDecisions.map(d => item('◇', d.text, inner, false, 'warning'))}
        <Text> </Text>

        <Box flexDirection="row" justifyContent="space-between" width={inner}>
          {header('Todos', allTodos.length ? `${doneCount}/${allTodos.length}` : '')}
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
        {allTodos.length === 0 && empty('Noch keine Todos.')}
        {allTodos.filter(t => !t.isDone).map(t => (t.isActive ? item('▸', t.text, inner, false, 'warning') : item('○', t.text, inner)))}
        {/* Finished todos fold into one line so open work stays on top */}
        {doneCount > 0 && <Text color="success">{`  ✓ ${doneCount} erledigt`}</Text>}
      </Box>
    )
  })
}
