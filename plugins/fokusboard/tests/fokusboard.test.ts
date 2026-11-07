import { describe, expect, mock, test } from 'claude-code/testing'

import type { PlanStatus } from '../types'
import {
  DEFAULT_GRIFFE,
  addGriff,
  editGriff,
  ago,
  applyUpdate,
  artifactKind,
  asksUser,
  describeBoard,
  fillPlan,
  findingsText,
  hostOf,
  fromDialog,
  isCovered,
  isPlanPath,
  keepBoard,
  newIntents,
  nextSteps,
  parseHeaders,
  pipeline,
  planOf,
  questionsIn,
  stageOf,
  summarize,
} from '../hooks/register'

const SURFACES = ['terminal', 'desktop'] as const
const TOOL = 'mcp__fokusboard__update'
const PANE = {
  plugin: 'fokusboard',
  component: 'Pane',
  requestId: 'fokusboard',
  props: {
    title: 'Fokusboard',
    isFocused: false,
    bodyColumns: 52,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const EMPTY = { thread: null, topic: null, todos: [], decisions: [], artifacts: [], log: [] }

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

const status = (over: Partial<PlanStatus>): PlanStatus => ({
  path: '/r/docs/x.md',
  name: 'x',
  exists: true,
  planVersion: 1,
  integratedReview: null,
  latestReview: null,
  verifiedVersion: null,
  verifyResult: null,
  hasReview: false,
  hasVerify: false,
  planMtime: 100,
  ...over,
})

// A tiny file system for the session tests: path → text
const files = (on: any, tree: Record<string, string>) => {
  const missing = { deny: 'ENOENT: no such file' }
  on('fs.read', (_$: unknown, e: { path: string }) => (e.path in tree ? { value: tree[e.path] } : missing))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in tree }))
  on('fs.stat', (_$: unknown, e: { path: string }) =>
    e.path in tree ? { value: { kind: 'file', size: tree[e.path]!.length, mtimeMs: 100, isLink: false } } : missing,
  )
}

// The prompt box: what was filled and what was sent
const promptBox = (on: any) => {
  const filled: string[] = []
  const sent: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$: unknown, e: { text: string }) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  return { filled, sent }
}

describe('board', () => {
  test('topic is set, trimmed, capped at five points and replaced as a whole', () => {
    let board = applyUpdate(EMPTY, {
      topic: { title: ' Stripe-Abgleich ', summary: 'Webhooks fehlen noch.', points: ['a', ' ', 'b', 'c', 'd', 'e', 'f'] },
    })
    expect(board.topic).toMatchObject({ title: 'Stripe-Abgleich', summary: 'Webhooks fehlen noch.', points: ['a', 'b', 'c', 'd', 'e'] })
    board = applyUpdate(board, { topic: { title: 'Neu', summary: 'Anders.' } })
    expect(board.topic).toMatchObject({ title: 'Neu', summary: 'Anders.', points: [] })
    expect(applyUpdate(board, { add_todos: ['x'] }).topic?.title).toBe('Neu')
  })

  test('the thread is set once and replaced only with a reason', () => {
    let board = applyUpdate(EMPTY, { thread: { title: ' Mods einrichten ', goal: 'Claude Code mit Mods ausbauen.' } })
    expect(board.thread).toEqual({ title: 'Mods einrichten', goal: 'Claude Code mit Mods ausbauen.' })
    // A step-level rewrite without why is ignored
    board = applyUpdate(board, { thread: { title: 'Icon tauschen', goal: 'Neues Icon.' } })
    expect(board.thread?.title).toBe('Mods einrichten')
    board = applyUpdate(board, { thread: { title: 'Release', goal: 'Neues Ziel.', why: 'Mods fertig, jetzt Release' } })
    expect(board.thread).toEqual({ title: 'Release', goal: 'Neues Ziel.' })
  })

  test('todos and decisions work by id; clear_done drops finished todos', () => {
    let board = applyUpdate(EMPTY, { add_todos: ['Write', 'Test', 'Drop'], open_decisions: ['Ship?'] })
    board = applyUpdate(board, { done_todos: ['t1'], remove_todos: ['t3'], start_todo: 't2', decide: [{ id: 'd1', answer: 'yes' }] }, 9)
    expect(board.todos).toEqual([
      { id: 't1', text: 'Write', isDone: true, isActive: false },
      { id: 't2', text: 'Test', isDone: false, isActive: true, startedAt: 9 },
    ])
    expect(board.decisions).toEqual([])
    expect(applyUpdate(board, { clear_done: true }).todos.map(t => t.id)).toEqual(['t2'])
  })

  test('a question carries context, options, a recommendation and a weight, and can be sharpened later', () => {
    let board = applyUpdate(
      EMPTY,
      {
        open_decisions: [
          { question: ' Staging zuerst? ', context: ' Prod-Deploy hängt daran. ', options: ['Ja', ' ', 'Nein'], recommended: 'Ja', weight: 'blocking' },
          'Welcher Editor?',
        ],
      },
      5,
    )
    expect(board.decisions).toEqual([
      { id: 'd1', text: 'Staging zuerst?', context: 'Prod-Deploy hängt daran.', options: ['Ja', 'Nein'], recommended: 'Ja', weight: 'blocking', at: 5 },
      { id: 'd2', text: 'Welcher Editor?', at: 5 },
    ])
    board = applyUpdate(board, { edit_decisions: [{ id: 'd2', context: 'Für die Hilfe-Screenshots.', weight: 'optional' }] })
    expect(board.decisions[1]).toEqual({ id: 'd2', text: 'Welcher Editor?', context: 'Für die Hilfe-Screenshots.', weight: 'optional', at: 5 })
  })

  test('artifacts are added by href without duplicates and removed by href', () => {
    let board = applyUpdate(EMPTY, { add_artifacts: [{ label: 'PR #12', href: 'https://x/pr/12' }, { label: 'Doc', href: 'https://x/doc' }] })
    board = applyUpdate(board, { add_artifacts: [{ label: 'PR #12 (neu)', href: 'https://x/pr/12' }], remove_artifacts: ['https://x/doc'] })
    expect(board.artifacts).toEqual([{ label: 'PR #12 (neu)', href: 'https://x/pr/12' }])
  })

  test('the board reads back with topic, plans, ids and the weight of a question', () => {
    expect(describeBoard(EMPTY)).toContain('Thread: (none yet')
    expect(describeBoard(EMPTY)).toContain('Topic: (none yet')
    expect(
      describeBoard(
        {
          thread: null,
          topic: { title: 'T', summary: 'S', points: ['p'] },
          todos: [{ id: 't1', text: 'Write', isDone: false, isActive: true }],
          decisions: [{ id: 'd1', text: 'Which?' }, { id: 'd2', text: 'Ship?', weight: 'blocking', recommended: 'yes' }],
          artifacts: [],
          log: [],
        },
        [status({ hasReview: true, latestReview: 2, integratedReview: 1 })],
        'plan',
      ),
    ).toBe(
      'Fokusboard now:\nThread: (none yet; set thread with the overall goal of this conversation)\nTopic: T: S\n  - p\nMode: plan mode\nPlan /r/docs/x.md: Review #2 einarbeiten\nt1 [>] Write\nd1 [?] Which?\nd2 [? blocking] Ship? (recommended: yes)',
    )
  })

  test('the transcript line names what changed', () => {
    expect(summarize({ topic: { title: 'X', summary: 'y' }, track_plans: ['a'], add_todos: ['a'], decide: [{ id: 'd1', answer: 'z' }] })).toBe(
      'Fokusboard: topic "X", +1 plan, +1 todo, 1 decided',
    )
  })
})

describe('questions in a reply', () => {
  test('question lines near the end are found outside code, also before a closing line', () => {
    expect(asksUser('Gespeichert.\n\nSoll ich das löschen?')).toBe(true)
    expect(asksUser('Run:\n\n```\necho ok?\n```')).toBe(false)
    expect(questionsIn('Zwei Punkte:\n1. **Staging zuerst?**\n2. Welcher Editor?\n\nSag Bescheid, dann geht es weiter.')).toEqual([
      '1. **Staging zuerst?**',
      '2. Welcher Editor?',
    ])
  })

  test('a question is covered when most of its words are in an open decision', () => {
    const open = [{ id: 'd1', text: 'Soll Staging vor Prod deployt werden?' }]
    expect(isCovered('Deployen wir Staging vor Prod?', open)).toBe(true)
    expect(isCovered('Welcher Editor für die Hilfe?', open)).toBe(false)
  })

  test("a dialog's questions become decisions; one already open is reused", () => {
    const { decisions, ids } = fromDialog(
      [{ id: 'd1', text: 'Staging zuerst?' }],
      [
        { question: 'Staging zuerst?', header: 'Deploy', options: [{ label: 'Ja' }, { label: 'Nein' }] },
        { question: 'Welcher Editor?', header: 'Editor', options: [{ label: 'VS Code (Recommended)' }, { label: 'Zed' }] },
      ],
      7,
    )
    expect(ids).toEqual([
      { id: 'd1', question: 'Staging zuerst?' },
      { id: 'd2', question: 'Welcher Editor?' },
    ])
    expect(decisions[1]).toEqual({ id: 'd2', text: 'Welcher Editor?', context: 'Editor', options: ['VS Code', 'Zed'], recommended: 'VS Code', weight: 'important', at: 7 })
  })
})

describe('griffe', () => {
  test('a typed prompt becomes a Griff once, its label shortened; {plan} takes the open plan', () => {
    let list = addGriff([], '  /simplify ')
    list = addGriff(list, '/simplify')
    list = addGriff(list, '')
    list = addGriff(list, 'Lies die verify-Datei und schließe die Lücken im Rahmen des Plans.')
    expect(list.map(g => g.label)).toEqual(['/simplify', 'Lies die verify-Datei und…'])
    expect(addGriff([], 'x', 'Eigener Name')[0]).toEqual({ label: 'Eigener Name', text: 'x' })
    expect(fillPlan('sol loop verify {plan}', '.claude/plans/a.md')).toBe('sol loop verify .claude/plans/a.md')
    expect(fillPlan('sol loop verify {plan}', null)).toBe('sol loop verify {plan}')
    expect(DEFAULT_GRIFFE.map(g => g.label)).toContain('Plan komplett umsetzen')
  })

  test('editGriff changes label and prompt in place, an empty prompt changes nothing', () => {
    const list = [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }]
    expect(editGriff(list, 1, ' /verify ', 'Prüfen')).toEqual([{ label: 'A', text: 'a' }, { label: 'Prüfen', text: '/verify' }])
    expect(editGriff(list, 0, '  ')).toBe(list)
    expect(editGriff(list, 5, 'x')).toBe(list)
  })
})

describe('board details', () => {
  test('a new topic title starts a new topic and keeps the old one in the trail; a new summary keeps the time', () => {
    let board = applyUpdate(EMPTY, { topic: { title: 'A', summary: 's' } }, 100)
    board = applyUpdate(board, { topic: { title: 'A', summary: 'anders' } }, 200)
    expect(board.topic).toMatchObject({ title: 'A', summary: 'anders', at: 100 })
    board = applyUpdate(board, { topic: { title: 'B', summary: 's' } }, 300)
    expect(board.topic?.at).toBe(300)
    expect(board.trail).toEqual([{ title: 'A', at: 100 }])
  })

  test('starting a todo stamps when; it keeps the stamp while it stays active', () => {
    let board = applyUpdate(EMPTY, { add_todos: ['a', 'b'] }, 1)
    board = applyUpdate(board, { start_todo: 't1' }, 50)
    board = applyUpdate(board, { start_todo: 't1' }, 90)
    expect(board.todos[0]).toMatchObject({ isActive: true, startedAt: 50 })
    board = applyUpdate(board, { start_todo: 't2' }, 120)
    expect(board.todos.map(t => [t.isActive, t.startedAt])).toEqual([[false, 50], [true, 120]])
  })

  test('options may carry a note on what they do', () => {
    const board = applyUpdate(EMPTY, { open_decisions: [{ question: 'Jetzt?', options: [{ label: 'Ja', note: 'startet sofort' }, 'Nein'] }] }, 1)
    expect(board.decisions[0]).toMatchObject({ options: ['Ja', 'Nein'], notes: ['startet sofort', ''] })
    const { decisions } = fromDialog([], [{ question: 'Editor?', options: [{ label: 'Zed', description: 'schnell' }, { label: 'VS Code' }] }], 2)
    expect(decisions[0]).toMatchObject({ options: ['Zed', 'VS Code'], notes: ['schnell', ''] })
  })

  test('artifacts are told apart by their URL', () => {
    expect(artifactKind('https://claude.ai/artifact/abc').kind).toBe('artifact')
    expect(artifactKind('https://github.com/o/r/pull/412').kind).toBe('pr')
    expect(artifactKind('https://example.com/doc').kind).toBe('doc')
    expect(hostOf('https://github.com/o/published/pull/412')).toBe('github · published #412')
    expect(hostOf('https://www.claude.ai/artifact/x')).toBe('claude.ai')
  })
})

describe('decision log', () => {
  test('a decided question moves into the log with its answer', () => {
    let board = applyUpdate(EMPTY, { open_decisions: ['Staging zuerst?', 'Welcher Editor?'] }, 400)
    board = applyUpdate(board, { decide: [{ id: 'd1', answer: ' ja, erst Staging ' }] }, 1000)
    expect(board.decisions.map(d => d.text)).toEqual(['Welcher Editor?'])
    expect(board.log).toEqual([{ text: 'Staging zuerst?', answer: 'ja, erst Staging', at: 1000, openedAt: 400 }])
    expect(describeBoard(board)).toContain('Decided: Staging zuerst? → ja, erst Staging')
  })

  test('times read as German relative times', () => {
    expect(ago(20_000)).toBe('gerade eben')
    expect(ago(5 * 60_000)).toBe('vor 5 min')
    expect(ago(3 * 3_600_000)).toBe('vor 3 h')
    expect(ago(26 * 3_600_000)).toBe('vor 1 Tag')
    expect(ago(72 * 3_600_000)).toBe('vor 3 Tagen')
  })
})

describe('plan workflow', () => {
  test('headers are read as the workflow skills write them', () => {
    const plan = 'Plan Version #3\n…\nPlan Version #2 — Review #1 eingearbeitet\nPlan Version #3 — Review #2 eingearbeitet\n'
    const review = 'Review Version #1\n…\nReview Version #3\nGeprüft gegen Plan Version #3 · GPT Sol (sol-plan, Runde 2, Delta)\n- [kritisch] a\n- [wichtig] b\n- [wichtig] c\n'
    const verify = 'Verifikation gegen Plan Version #2 — Ergebnis: Lücken\n…\nVerifikation gegen Plan Version #3 — Ergebnis: **vollständig**\n'
    expect(parseHeaders(plan, review, verify)).toEqual({
      planVersion: 3,
      integratedReview: 2,
      isPartial: false,
      latestReview: 3,
      reviewBy: 'Sol, Runde 2',
      reviewedVersion: 3,
      findings: { critical: 1, important: 2, optional: 0 },
      verifiedVersion: 3,
      verifyResult: 'vollständig',
    })
    expect(parseHeaders('', '', '')).toMatchObject({ planVersion: null, integratedReview: null, latestReview: null, reviewBy: null, verifiedVersion: null, verifyResult: null })
    // Partly worked in: open points wait on the person
    expect(parseHeaders('Plan Version #2\nPlan Version #2 — Review #2 teilweise eingearbeitet\n', 'Review Version #2\n', '').isPartial).toBe(true)
  })

  test('plans live under .claude/plans or docs; review and verify files belong to their plan', () => {
    expect(isPlanPath('/r/.claude/plans/x.md')).toBe(true)
    expect(isPlanPath('/r/docs/a/x.md')).toBe(true)
    expect(isPlanPath('/r/src/x.md')).toBe(false)
    expect(planOf('/r/.claude/plans/x.review.md')).toBe('/r/.claude/plans/x.md')
    expect(planOf('/r/docs/a/x.verify.md')).toBe('/r/docs/a/x.md')
    expect(planOf('/r/docs/a/x.md')).toBe('/r/docs/a/x.md')
  })

  test('each state of the workflow maps to its step', () => {
    expect(stageOf(status({ exists: false }), 0)).toEqual({ step: 'plan', label: 'Plan wird geschrieben', tone: 'busy' })
    expect(stageOf(status({}), 0).label).toBe('Review fehlt')
    expect(stageOf(status({ hasReview: true, latestReview: 2, integratedReview: 1 }), 0).label).toBe('Review #2 einarbeiten')
    expect(stageOf(status({ hasReview: true, latestReview: 2, integratedReview: 1, isPartial: true }), 0).label).toContain('teilweise')
    const settled = status({ hasReview: true, latestReview: 2, integratedReview: 2 })
    expect(stageOf(settled, 50).label).toBe('bereit zur Umsetzung, wartet auf dein Go')
    expect(stageOf(settled, 500).label).toBe('Umsetzung läuft')
    const verified = { ...settled, hasVerify: true, planVersion: 3 }
    expect(stageOf({ ...verified, verifiedVersion: 2, verifyResult: 'vollständig' }, 0).label).toBe('Verify veraltet (gegen v2)')
    expect(stageOf({ ...verified, verifiedVersion: 3, verifyResult: 'Lücken' }, 0).label).toBe('Nachbessern: Lücken')
    expect(stageOf({ ...verified, verifiedVersion: 3, verifyResult: 'vollständig' }, 0)).toEqual({ step: 'done', label: 'vollständig verifiziert', tone: 'ok' })
  })

  test('each stage offers its next step, by Sol or by hand', () => {
    const at = (s: PlanStatus, edit = 0) => nextSteps(s, stageOf(s, edit), '.claude/plans/x.md')
    const review = at(status({}))
    expect(review.buttons.map(b => b.text)).toEqual(['sol loop plan .claude/plans/x.md'])
    expect(review.hint).toContain('$plan-review .claude/plans/x.md')
    expect(at(status({ hasReview: true, latestReview: 2, integratedReview: 1 })).buttons.map(b => b.text)).toEqual([
      '/workflow:plan-integrate-review .claude/plans/x.md',
      'sol loop plan .claude/plans/x.md',
    ])
    const settled = status({ hasReview: true, latestReview: 2, integratedReview: 2 })
    expect(at(settled).buttons.map(b => b.label)).toEqual(['Umsetzen'])
    expect(at(settled, 500).buttons.map(b => b.text)).toEqual(['sol loop verify .claude/plans/x.md'])
    const gaps = { ...settled, hasVerify: true, verifiedVersion: 1, verifyResult: 'Lücken' as const }
    expect(at(gaps).buttons.map(b => b.label)).toEqual(['Nachbessern', 'Sol-Verify'])
    expect(findingsText({ critical: 1, important: 0, optional: 2 })).toBe('1 kritisch · 2 optional')
  })

  test('the pipeline marks passed, current and ahead steps', () => {
    expect(pipeline('integrate').map(x => x.state)).toEqual(['passed', 'passed', 'current', 'ahead', 'ahead'])
    expect(pipeline('done').every(x => x.state === 'passed')).toBe(true)
  })
})

describe('session', () => {
  test('the pane reads head, Jetzt, questions and todos in that order', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
    await $.tool.call({
      tool: TOOL,
      thread: { title: 'Payment v3 fertigstellen', goal: 'Checkout und Webhooks für Stripe produktionsreif machen.' },
      topic: { title: 'Payment v3', summary: 'Checkout läuft, Rückgabeseite fertig.', points: ['Stripe Sandbox'] },
      add_todos: ['Webhook testen', 'Deploy'],
      open_decisions: ['Staging zuerst?'],
    })
    await $.tool.call({ tool: TOOL, done_todos: ['t1'], start_todo: 't2' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect((await ui.find({ type: 'Text', text: 'Payment v3 fertigstellen' }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: 'Payment v3' }))?.props.bold).toBe(true)
      expect(all.indexOf('Payment v3 fertigstellen')).toBeLessThan(all.indexOf('JETZT'))
      expect(all.indexOf('JETZT')).toBeLessThan(all.indexOf('◆ WICHTIG'))
      expect(all.indexOf('◆ WICHTIG')).toBeLessThan(all.indexOf('TODOS'))
      expect(all).not.toContain('FRAGEN')
      expect(all).toContain('Checkout läuft, Rückgabeseite fertig.')
      expect(all).toContain('Stripe Sandbox')
      expect(all).toContain('◆ WICHTIG')
      expect(all).toContain('Staging zuerst?')
      // Every todo stays; the bar and the count ride in the header
      expect(all).toContain('Webhook testen')
      expect(all).toContain('Deploy')
      expect(all).toContain('1/2')
      expect(all).toContain('▰▰▰▰▰')
      expect(all).toContain('seit')
      expect(all).not.toContain('PLÄNE')
      await ui.unmount()
    }
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    expect(sections.at(-1)?.text).toContain('Thread: Payment v3 fertigstellen')
    expect(sections.at(-1)?.text).toContain('Topic: Payment v3')
    // A thread rewrite without why is refused and says so
    const refused = await $.tool.call({ tool: TOOL, thread: { title: 'Anderes', goal: 'x' } })
    expect('result' in refused && refused.result).toContain('Thread unchanged')
  })

  test('questions come blocking first, one row per answer with its note; an answer fills the prompt box', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const { filled, sent } = promptBox(on)
    await $.tool.call({
      tool: TOOL,
      open_decisions: [
        { question: 'Welche Farbe?', weight: 'optional' },
        {
          question: 'Staging zuerst?',
          context: 'Prod-Deploy hängt daran.',
          options: [{ label: 'Ja', note: 'erst Staging, dann Prod' }, 'Nein'],
          recommended: 'Ja',
          weight: 'blocking',
        },
      ],
    })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('● BLOCKIERT')
      expect(all).toContain('Prod-Deploy hängt daran.')
      expect(all).toContain('erst Staging, dann Prod')
      expect(all).toContain('Empfohlen')
      expect(all.indexOf('Staging zuerst?')).toBeLessThan(all.indexOf('Welche Farbe?'))
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(buttons).toEqual(expect.arrayContaining(['Ja', 'Nein', 'Eigene Antwort', 'Erklären']))
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'opt:d2:1' })
    expect(filled.at(-1)).toBe('Zu „Staging zuerst?“: Nein')
    await ui.press({ key: 'explain:d2' })
    expect(sent.at(-1)).toContain('Erklär mir die offene Frage d2')
    expect(sent.at(-1)).toContain('edit_decisions')
  })

  test("a dialog's questions land on the board and close with the answers", async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    let isDismissed = false
    on('tool.call', { tool: 'AskUserQuestion' }, (_$: unknown, e: { questions: readonly unknown[] }) =>
      isDismissed ? { result: 'dismissed', isError: true } : { result: { questions: e.questions, answers: { 'Staging zuerst?': 'Ja' } } },
    )
    const questions = [
      { question: 'Staging zuerst?', header: 'Deploy', options: [{ label: 'Ja', description: '' }, { label: 'Nein', description: '' }], multiSelect: false },
      { question: 'Welcher Editor?', header: 'Editor', options: [{ label: 'VS Code', description: '' }, { label: 'Zed', description: '' }], multiSelect: false },
    ]
    await $.tool.call({ tool: 'AskUserQuestion', questions })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)
    // Answered: gone from the pane; unanswered: still open
    expect(all).not.toContain('Staging zuerst?')
    expect(all).toContain('Welcher Editor?')
    // A dismissed dialog leaves its questions on the board, without doubling them
    isDismissed = true
    await $.tool.call({ tool: 'AskUserQuestion', questions: [questions[1]!] })
    expect((await texts(ui)).split('Welcher Editor?').length - 1).toBe(1)
  })

  test('plans show as a file tree with versions; artifacts with their kind and host', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.cwd', () => ({ value: '/r' }))
    files(on, {
      '/r/.claude/plans/stripe.md': 'Plan Version #2\n…\nPlan Version #2 — Review #1 eingearbeitet\n',
      '/r/.claude/plans/stripe.review.md': 'Review Version #1\nReview Version #2\nGeprüft gegen Plan Version #2 · GPT Sol (sol-plan, Runde 1)\n- [kritisch] x\n',
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/.claude/plans/stripe.md'], add_artifacts: [{ label: 'Checkout-Mockup', href: 'https://claude.ai/artifact/abc' }] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('PLÄNE')
      expect(all).toContain('v2')
      expect(all).toContain('#2 · gegen v2')
      expect(all).toContain('ARTEFAKTE')
      expect(all).toContain('claude.ai')
      expect((await ui.findAll({ type: 'Link' })).map(l => [l.props.label, l.props.href])).toContainEqual(['Checkout-Mockup', 'https://claude.ai/artifact/abc'])
      const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      if (surface === 'terminal') {
        expect(hrefs).toContain('file:///r/.claude/plans/stripe.md')
        expect(hrefs).toContain('file:///r/.claude/plans/stripe.review.md')
      } else {
        // The desktop draws no file:// link: a button opens the file instead
        expect(buttons).toContain('stripe.md')
        expect(buttons).toContain('review.md')
      }
      // No verify file yet: no row for it
      expect(all).not.toContain('verify.md')
      await ui.unmount()
    }
  })

  test('a finished plan shows its verify file with the result', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    files(on, {
      '/r/docs/x.md': 'Plan Version #2\nPlan Version #2 — Review #1 eingearbeitet\n',
      '/r/docs/x.review.md': 'Review Version #1\n',
      '/r/docs/x.verify.md': 'Verifikation gegen Plan Version #2 — Ergebnis: vollständig\n',
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/docs/x.md'] })
    const all = await texts(await $.ui.mount({ ...PANE, surface: 'terminal' }))
    expect(all).toContain('verify.md')
    expect(all).toContain('v2 · vollständig')
  })

  test('a desktop click opens the plan file with open', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    files(on, { '/r/docs/x.md': 'Plan Version #1\n' })
    const ran: string[][] = []
    on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
      ran.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/docs/x.md'] })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open:/r/docs/x.md' })
    expect(ran.filter(argv => argv[0] === 'open')).toEqual([['open', '/r/docs/x.md']])
  })

  test('reply puts the question in the prompt box; "alle beantworten" has Claude ask them all', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const { filled, sent } = promptBox(on)
    await $.tool.call({ tool: TOOL, open_decisions: ['Staging zuerst?', { question: 'Welcher Editor?', options: ['VS Code', 'Zed'] }] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(buttons).toContain('Eigene Antwort')
      expect(buttons).toContain('alle beantworten →')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'reply:d1' })
    expect(filled).toEqual(['Zu „Staging zuerst?“: '])
    await ui.press({ key: 'ask-all' })
    expect(sent.at(-1)).toContain('d1: Staging zuerst?\nd2: Welcher Editor? (Optionen: VS Code / Zed)')
    expect(sent.at(-1)).toContain('AskUserQuestion')
  })

  test('where the box cannot take the reply, Claude asks instead', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const sent: string[] = []
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', () => ({ isFilled: false, cause: 'no_composer' }))
    on('prompt.submit', (_$: unknown, e: { text: string }) => {
      sent.push(e.text)
      return { text: e.text }
    })
    on('ui.toast', () => ({ value: undefined }))
    await $.tool.call({ tool: TOOL, open_decisions: ['Staging zuerst?'] })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'reply:d1' })
    expect(sent.at(-1)).toContain('d1: Staging zuerst?')
  })

  const git = (on: any) => {
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', (_$: unknown, e: { argv: readonly string[] }) => ({
      value: { exitCode: 0, stdout: e.argv.includes('--show-toplevel') ? '/r\n' : 'feature/pay\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
  }
  // What a session start calls beneath the plugin
  const engineStart = (on: any) => {
    on('command.register', () => ({ value: undefined }))
    on('tool.register', () => ({ value: undefined }))
    on('clock.every', () => ({ value: undefined }))
    on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  }
  const memoryStore = (on: any, store: Record<string, unknown>) => {
    on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
      store[e.key] = JSON.parse(JSON.stringify(e.value))
      return { value: undefined }
    })
    on('store.get', (_$: unknown, e: { key: string }) => ({ value: store[e.key] }))
  }

  test('Griffe are one list across sessions: added in the pane, kept in the store, put in the prompt box', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const store: Record<string, unknown> = { griffe: [{ label: 'Simplify', text: '/simplify' }] }
    memoryStore(on, store)
    mock.env(on, {})
    engineStart(on)
    on('prompt.compose', () => ({ sections: [] }))
    const box = promptBox(on)
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'griff:0' })
    expect(box.filled).toEqual(['/simplify'])
    await ui.input({ key: 'griff-input-1', text: 'sol loop verify {plan}' })
    expect(store.griffe).toEqual([{ label: 'Simplify', text: '/simplify' }, { label: 'sol loop verify {plan}', text: 'sol loop verify {plan}' }])
  })

  test('a change reads the store fresh, so a Griff another session added is kept', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const store: Record<string, unknown> = { griffe: [{ label: 'A', text: 'a' }] }
    memoryStore(on, store)
    mock.env(on, {})
    engineStart(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    // Another session adds a Griff while this one runs
    store.griffe = [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }]
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const field = (await ui.find({ type: 'Input' }))!
    await ui.input({ key: String(field.key), text: 'c' })
    expect(store.griffe).toEqual([
      { label: 'A', text: 'a' },
      { label: 'B', text: 'b' },
      { label: 'c', text: 'c' },
    ])
  })

  test('a first session gets the default Griffe and no earlier board', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    memoryStore(on, {})
    engineStart(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const all = await texts(await $.ui.mount({ ...PANE, surface: 'terminal' }))
    expect(all).toContain('GRIFFE')
    expect(all).toContain('Noch kein Thema')
  })

  test('the terminal frames the board and draws each rule to the exact width', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, thread: { title: 'T', goal: 'G' } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const root = await ui.find({ type: 'Box' })
    expect(root?.props.borderStyle).toBe('round')
    // The frame fills the pane's height
    expect(root?.props.minHeight).toBe(60)
    // bodyColumns 52 → inner 48; "GRIFFE " is 7 cells, so the rule is 41
    const rule = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^─+$/.test(t))
    expect(rule?.length).toBe(41)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await desktop.find({ type: 'Box' }))?.props.borderStyle).toBeUndefined()
  })

  test('the empty pane invites a topic', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)
    expect(all).toContain('Noch kein Thema')
    // The placeholder is a plain line, not a frame inside the frame
    expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle).length).toBe(1)
    expect(all).not.toContain('TODOS')
  })

  test('finished todos can be hidden and shown again', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, add_todos: ['Alt', 'Neu'] })
    await $.tool.call({ tool: TOOL, done_todos: ['t1'] })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await texts(ui)).toContain('Alt')
    await ui.press({ key: 'toggle-done' })
    expect(await texts(ui)).not.toContain('Alt')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toContain('1 erledigte einblenden')
    await ui.press({ key: 'toggle-done' })
    expect(await texts(ui)).toContain('Alt')
  })

  test('a question left only in the reply sends Claude back once, even with older questions open', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('classic.Stop', () => ({}))
    on('classic.UserPromptSubmit', () => ({}))
    await $.tool.call({ tool: TOOL, open_decisions: ['Welcher Editor?'] })
    await $.classic.UserPromptSubmit({ prompt: 'weiter' })
    const asking = { stop_hook_active: false, last_assistant_message: 'Fertig.\n\nSoll ich deployen?' }
    expect((await $.classic.Stop(asking)).block).toContain('open_decisions')
    expect((await $.classic.Stop({ ...asking, stop_hook_active: true })).block).toBeUndefined()
    // Asking again about what is already open is no news
    expect((await $.classic.Stop({ ...asking, last_assistant_message: 'Welcher Editor soll es sein?' })).block).toBeUndefined()
    // Once this turn put its question on the board, nothing more is asked
    await $.tool.call({ tool: TOOL, open_decisions: ['Soll ich deployen?'] })
    expect((await $.classic.Stop(asking)).block).toBeUndefined()
  })
})

describe('footer switch', () => {
  test('◎ Fokus sits beside the mode labels and opens, then closes the board', async ($, on) => {
    let isUp = false
    const pane = { id: 'fokusboard', title: 'Fokusboard', isShown: true, isFocused: false, isPlaced: true }
    on('ui.panes', () => ({ value: isUp ? [pane] : [] }))
    on('ui.open', () => ((isUp = true), { value: { isPlaced: true } }))
    on('ui.close', () => ((isUp = false), { value: undefined }))
    const ui = await $.ui.mount({ plugin: 'fokusboard', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
    expect(await texts(ui)).toContain('focus')
    await ui.press({ key: 'fokus-toggle' })
    expect(isUp).toBe(true)
    await ui.press({ key: 'fokus-toggle' })
    expect(isUp).toBe(false)
  })
})

describe('herdr sidebar', () => {
  test('clicks are read once, oldest first, and junk lines are skipped', () => {
    const text = ['{"at":5,"do":"refresh"}', 'kaputt', '{"at":3,"do":"griff.add","text":"a"}', '{"at":1,"do":"refresh"}', '{"do":"refresh"}'].join('\n')
    expect(newIntents(text, 2).map(x => x.at)).toEqual([3, 5])
    expect(newIntents(text, 5)).toEqual([])
  })

  // A session in Herdr terminal t9: what it writes, what the sidebar left in its inbox
  const herdrSession = async ($: any, on: any) => {
    const written: Record<string, string> = {}
    const tree: Record<string, string> = {}
    const opened: string[] = []
    const ran: string[][] = []
    mock.env(on, { HC_TERMINAL_ID: 't9', HOME: '/h' })
    const clock = mock.clock(on, { now: 0 })
    on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
      written[e.path] = e.text
      return { value: undefined }
    })
    files(on, tree)
    on('ui.open', (_$: unknown, e: { id: string }) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
      ran.push([...e.argv])
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.cwd', () => ({ value: '/r' }))
    on('command.register', () => ({ value: undefined }))
    on('tool.register', () => ({ value: undefined }))
    on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
    mock.store(on)
    const box = promptBox(on)
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const board = () => JSON.parse(written['/h/.local/state/fokusboard/t9.json'] ?? 'null')
    return { written, tree, opened, ran, clock, box, board }
  }

  test('the board goes to the terminal\'s snapshot file; the terminal pane stays closed', async ($, on) => {
    const s = await herdrSession($, on)
    await $.tool.call({ tool: TOOL, topic: { title: 'Sidebar', summary: 'Live.' }, open_decisions: [{ question: 'Tab?', options: ['Ja', 'Nein'] }] })
    await s.clock.advance(1000)
    expect(s.board()).toMatchObject({ terminal: 't9', ended: false, topic: { title: 'Sidebar' }, decisions: [{ id: 'd1', text: 'Tab?' }] })
    expect(typeof s.board().updatedAt).toBe('number')
    // The first content opens nothing in Herdr (the Fokus button counts the questions) …
    expect(s.opened).toEqual([])
    expect(s.ran.some(a => a.includes('layout.select'))).toBe(false)
    // … and /fokus shows the Fokus tab of Herdr's panel, not the terminal pane
    // The test's `$` types the engine-side input; the command needs only its name here
    await ($.command.run as (input: { command: string; args: string }) => Promise<unknown>)({ command: 'fokus', args: '' })
    expect(s.opened).toEqual([])
    expect(s.ran.some(a => a.includes('layout.select'))).toBe(true)
  })

  test('a click on an option fills the prompt box; a Griff from the sidebar lands in the list', async ($, on) => {
    const s = await herdrSession($, on)
    await $.tool.call({ tool: TOOL, open_decisions: [{ question: 'Tab?', options: ['Ja', 'Nein'] }] })
    const at = Date.now() + 10
    s.tree['/h/.local/state/fokusboard/t9.inbox.jsonl'] =
      JSON.stringify({ at, do: 'answer', id: 'd1', option: 'Ja' }) + '\n' + JSON.stringify({ at: at + 1, do: 'griff.add', text: '/security-review' })
    await s.clock.advance(1000)
    expect(s.box.filled).toEqual(['Zu „Tab?“: Ja'])
    expect(s.box.sent).toEqual([])
    expect(JSON.parse(s.written['/h/.local/state/fokusboard/griffe.json']!).at(-1)).toEqual({ label: '/security-review', text: '/security-review' })
    expect(s.board().griffe).toBeUndefined()
    // The same clicks are not carried out twice
    await s.clock.advance(1000)
    expect(s.box.filled).toEqual(['Zu „Tab?“: Ja'])
  })

  test('clicks left from before the session started are ignored', async ($, on) => {
    const s = await herdrSession($, on)
    await $.tool.call({ tool: TOOL, open_decisions: ['Tab?'] })
    s.tree['/h/.local/state/fokusboard/t9.inbox.jsonl'] = JSON.stringify({ at: 1, do: 'answer', id: 'd1', option: 'Ja' })
    await s.clock.advance(1000)
    expect(s.box.filled).toEqual([])
  })
})

describe('resume', () => {
  const saved = (at: number, title: string) => ({ at, thread: { title, goal: 'g' }, topic: null, decisions: [], todos: [], artifacts: [], log: [], plans: [] })

  test('only the newest sessions are kept', () => {
    let all = {}
    for (let i = 0; i < 35; i++) all = keepBoard(all, `s${i}`, saved(i, `T${i}`))
    expect(Object.keys(all)).toHaveLength(30)
    expect(Object.keys(all)).toContain('s34')
    expect(Object.keys(all)).not.toContain('s0')
  })

  // A session start with the given id over a store that already holds boards
  const start = async ($: any, on: any, id: string) => {
    mock.store(on, { boards: { old: saved(1, 'Payment v3') } })
    mock.env(on, {})
    on('session.id', () => ({ value: id }))
    on('session.cwd', () => ({ value: '/r' }))
    on('command.register', () => ({ value: undefined }))
    on('tool.register', () => ({ value: undefined }))
    on('clock.every', () => ({ value: undefined }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('classic.SessionStart', () => ({}))
    // As the engine orders them: the classic SessionStart (the transcript's id, also for --resume) first
    await $.classic.SessionStart({ source: id === 'old' ? 'resume' : 'startup', session_id: id })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    // An empty update answers with the board as it stands
    const ran = await $.tool.call({ tool: TOOL })
    return JSON.stringify(ran)
  }

  test('a resumed session (same id) gets its board back', async ($, on) => {
    expect(await start($, on, 'old')).toContain('Thread: Payment v3')
  })

  test('a new session starts with an empty board', async ($, on) => {
    expect(await start($, on, 'new')).not.toContain('Payment v3')
  })
})
