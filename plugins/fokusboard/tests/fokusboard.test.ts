import { describe, expect, test } from 'claude-code/testing'

import type { PlanStatus } from '../types'
import {
  addNote,
  ago,
  applyUpdate,
  asksUser,
  describeBoard,
  describeNotes,
  findingsText,
  fromDialog,
  isCovered,
  isPlanPath,
  nextSteps,
  noticesFor,
  parseHeaders,
  pipeline,
  planOf,
  questionsIn,
  sortNotes,
  stageOf,
  stillDue,
  summarize,
  toggleNote,
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
    expect(board.topic).toEqual({ title: 'Stripe-Abgleich', summary: 'Webhooks fehlen noch.', points: ['a', 'b', 'c', 'd', 'e'] })
    board = applyUpdate(board, { topic: { title: 'Neu', summary: 'Anders.' } })
    expect(board.topic).toEqual({ title: 'Neu', summary: 'Anders.', points: [] })
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
    board = applyUpdate(board, { done_todos: ['t1'], remove_todos: ['t3'], start_todo: 't2', decide: [{ id: 'd1', answer: 'yes' }] })
    expect(board.todos).toEqual([
      { id: 't1', text: 'Write', isDone: true, isActive: false },
      { id: 't2', text: 'Test', isDone: false, isActive: true },
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

describe('own notes', () => {
  test('notes are added, ticked off, sorted open first and shown to Claude read-only', () => {
    let list = addNote([], '  Kunde anrufen ', 1)
    list = addNote(list, '', 2)
    list = addNote(list, 'Mail an Tim', 3)
    expect(list.map(n => n.text)).toEqual(['Kunde anrufen', 'Mail an Tim'])
    list = toggleNote(list, list[0]!.id)
    expect(sortNotes(list).map(n => n.text)).toEqual(['Mail an Tim', 'Kunde anrufen'])
    expect(describeNotes(list)).toContain('[x] Kunde anrufen')
    expect(describeNotes(list)).toContain('never change them')
  })
})

describe('decision log', () => {
  test('a decided question moves into the log with its answer', () => {
    let board = applyUpdate(EMPTY, { open_decisions: ['Staging zuerst?', 'Welcher Editor?'] })
    board = applyUpdate(board, { decide: [{ id: 'd1', answer: ' ja, erst Staging ' }] }, 1000)
    expect(board.decisions.map(d => d.text)).toEqual(['Welcher Editor?'])
    expect(board.log).toEqual([{ text: 'Staging zuerst?', answer: 'ja, erst Staging', at: 1000 }])
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

describe('plan notices', () => {
  const base = status({ hasReview: true, latestReview: 1, integratedReview: 1 })
  test('a new review and a new verify result are news; a first sighting is not', () => {
    expect(noticesFor([], [base], 1)).toEqual([])
    expect(noticesFor([base], [{ ...base, latestReview: 2 }], 1).map(n => [n.kind, n.label])).toEqual([['review', 'Review #2 zu x ist da']])
    const gaps = { ...base, hasVerify: true, verifiedVersion: 1, verifyResult: 'Lücken' as const }
    expect(noticesFor([base], [gaps], 1).map(n => n.kind)).toEqual(['gaps'])
    expect(noticesFor([gaps], [{ ...gaps, verifyResult: 'vollständig' as const }], 1).map(n => n.kind)).toEqual(['verified'])
  })

  test('a notice goes once its step is done', () => {
    const review = { path: '/r/docs/x.md', name: 'x', kind: 'review' as const, label: '', at: 1 }
    expect(stillDue(review, [{ ...base, latestReview: 2 }])).toBe(true)
    expect(stillDue(review, [{ ...base, latestReview: 2, integratedReview: 2 }])).toBe(false)
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
  test('the tool fills the pane with a topic card, questions and todos', async ($, on) => {
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
      if (surface === 'terminal') expect(all).toContain('◎')
      else expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Thema')
      expect((await ui.find({ type: 'Text', text: 'Payment v3' }))?.props.bold).toBe(true)
      expect(all).toContain('WORUM ES GEHT')
      expect(all).toContain('Checkout und Webhooks für Stripe produktionsreif machen.')
      // The anchor comes before the current step, and the open question right after it
      expect(all.indexOf('Payment v3 fertigstellen')).toBeLessThan(all.indexOf('AKTUELL'))
      expect(all.indexOf('AKTUELL')).toBeLessThan(all.indexOf('OFFENE FRAGEN'))
      expect(all).toContain('Checkout läuft, Rückgabeseite fertig.')
      expect(all).toContain('Stripe Sandbox')
      expect(all).toContain('◆')
      expect(all).toContain('Staging zuerst?')
      expect(all).toContain('Deploy')
      expect(all).toContain('✓ 1 erledigt')
      expect(all).toContain('TODOS')
      expect(all).toContain('1/2')
      expect(all).toContain('▰▰▰▰▰')
      expect(all).not.toContain('Webhook testen')
      // No plan tracked and not in plan mode: no workflow section
      expect(all).not.toContain('PLAN-WORKFLOW')
      await ui.unmount()
    }
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    expect(sections.at(-1)?.text).toContain('Thread: Payment v3 fertigstellen')
    expect(sections.at(-1)?.text).toContain('Topic: Payment v3')
    expect(sections.at(-1)?.text).not.toContain('Weitermachen')
    // A thread rewrite without why is refused and says so
    const refused = await $.tool.call({ tool: TOOL, thread: { title: 'Anderes', goal: 'x' } })
    expect('result' in refused && refused.result).toContain('Thread unchanged')
  })

  test('questions are grouped by weight with context and options; an option fills the answer', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const { filled, sent } = promptBox(on)
    await $.tool.call({
      tool: TOOL,
      open_decisions: [
        { question: 'Welche Farbe?', weight: 'optional' },
        { question: 'Staging zuerst?', context: 'Prod-Deploy hängt daran.', options: ['Ja', 'Nein'], recommended: 'Ja', weight: 'blocking' },
      ],
    })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('2 · 1 blockiert')
      expect(all).toContain('Blockiert die Arbeit')
      expect(all).toContain('Prod-Deploy hängt daran.')
      // Blocking first, optional last
      expect(all.indexOf('Staging zuerst?')).toBeLessThan(all.indexOf('Welche Farbe?'))
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(buttons).toContain('Ja ★')
      expect(buttons).toContain('✦ Erklär mir das')
      expect(buttons).toContain('× verwerfen')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'opt:d2:1' })
    expect(filled.at(-1)).toBe('Zu „Staging zuerst?“: Nein')
    await ui.press({ key: 'explain:d2' })
    expect(sent.at(-1)).toContain('Erklär mir die offene Frage d2')
    expect(sent.at(-1)).toContain('edit_decisions')
    await ui.press({ key: 'drop:d1' })
    const after = await texts(ui)
    expect(after).toContain('verworfen')
    expect(after).not.toContain('Blockiert die Arbeit')
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
    // Answered: in the log; unanswered: still open
    expect(all).toContain('ENTSCHIEDEN')
    expect(all).toContain('Ja')
    expect(all).toContain('OFFENE FRAGEN')
    expect(all).toContain('Welcher Editor?')
    // A dismissed dialog leaves its questions on the board, without doubling them
    isDismissed = true
    await $.tool.call({ tool: 'AskUserQuestion', questions: [questions[1]!] })
    expect((await texts(ui)).split('Welcher Editor?').length - 1).toBe(1)
  })

  test('a tracked plan shows its step, review, next steps and links its files', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.cwd', () => ({ value: '/r' }))
    const { filled } = promptBox(on)
    files(on, {
      '/r/.claude/plans/stripe.md': 'Plan Version #2\n…\nPlan Version #2 — Review #1 eingearbeitet\n',
      '/r/.claude/plans/stripe.review.md': 'Review Version #1\nReview Version #2\nGeprüft gegen Plan Version #2 · GPT Sol (sol-plan, Runde 1)\n- [kritisch] x\n',
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/.claude/plans/stripe.md'], add_artifacts: [{ label: 'Checkout-Mockup', href: 'https://claude.ai/artifact/abc' }] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('PLAN-WORKFLOW')
      expect(all).toContain('stripe')
      expect(all).toContain('●●◉○○')
      expect(all).toContain('3/5 Einarbeiten: Review #2 einarbeiten')
      expect(all).toContain('Review #2 · Sol, Runde 1 · gegen v2 · 1 kritisch')
      expect(all).toContain('ARTEFAKTE')
      expect((await ui.findAll({ type: 'Link' })).map(l => [l.props.label, l.props.href])).toContainEqual(['Checkout-Mockup', 'https://claude.ai/artifact/abc'])
      const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(buttons).toContain('Einarbeiten')
      expect(buttons).toContain('Sol-Loop')
      if (surface === 'terminal') {
        expect(hrefs).toContain('file:///r/.claude/plans/stripe.md')
        expect(hrefs).toContain('file:///r/.claude/plans/stripe.review.md')
      } else {
        // The desktop draws no file:// link: a button opens the file instead
        expect(buttons).toContain('Plan v2')
        expect(buttons).toContain('Review #2')
      }
      // No verify file yet: plain text, nothing to open
      expect(buttons).not.toContain('Verify')
      expect(hrefs).not.toContain('file:///r/.claude/plans/stripe.verify.md')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'step:sol-plan:/r/.claude/plans/stripe.md' })
    expect(filled.at(-1)).toBe('sol loop plan .claude/plans/stripe.md')
  })

  test('a finished plan folds into one line', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    files(on, {
      '/r/docs/x.md': 'Plan Version #2\nPlan Version #2 — Review #1 eingearbeitet\n',
      '/r/docs/x.review.md': 'Review Version #1\n',
      '/r/docs/x.verify.md': 'Verifikation gegen Plan Version #2 — Ergebnis: vollständig\n',
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/docs/x.md'] })
    const all = await texts(await $.ui.mount({ ...PANE, surface: 'terminal' }))
    expect(all).toContain('v2 · vollständig verifiziert')
    expect(all).not.toContain('●●●●●')
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

  test('plan mode shows in the pane before any plan is saved', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('classic.UserPromptSubmit', () => ({}))
    await $.classic.UserPromptSubmit({ prompt: 'Lass uns das planen', permission_mode: 'plan' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)
    expect(all).toContain('◉ Planmodus')
    expect(all).toContain('Wir planen gerade')
  })

  test('reply puts the question in the prompt box; ask has Claude put it to the person', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const { filled, sent } = promptBox(on)
    await $.tool.call({ tool: TOOL, open_decisions: ['Staging zuerst?', { question: 'Welcher Editor?', options: ['VS Code', 'Zed'] }] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(buttons).toContain('↩ Antworten')
      expect(buttons).toContain('? Frag mich')
      expect(buttons).toContain(' Alle stellen')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'reply:d1' })
    expect(filled).toEqual(['Zu „Staging zuerst?“: '])
    await ui.press({ key: 'ask:d2' })
    expect(sent.at(-1)).toContain('d2: Welcher Editor? (Optionen: VS Code / Zed)')
    expect(sent.at(-1)).toContain('AskUserQuestion')
    await ui.press({ key: 'ask-all' })
    expect(sent.at(-1)).toContain('d1: Staging zuerst?\nd2: Welcher Editor?')
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

  test('a review that lands outside the session shows a notice whose button fills the integrate command', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.cwd', () => ({ value: '/r' }))
    const { filled } = promptBox(on)
    const tree: Record<string, string> = {
      '/r/docs/x.md': 'Plan Version #1\nPlan Version #1 — Review #1 eingearbeitet\n',
      '/r/docs/x.review.md': 'Review Version #1\n',
    }
    files(on, tree)
    await $.tool.call({ tool: TOOL, track_plans: ['/r/docs/x.md'] })
    // Codex writes review #2 outside the session; the next read sees it
    tree['/r/docs/x.review.md'] = 'Review Version #1\nReview Version #2\n'
    await $.tool.call({ tool: TOOL })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await texts(ui)).toContain('Review #2 zu x ist da')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'act:review/r/docs/x.md' })
    expect(filled).toEqual(['/workflow:plan-integrate-review docs/x.md'])
    expect(await texts(ui)).not.toContain('Review #2 zu x ist da')
  })

  test('a review this session writes itself (a sol loop) raises no notice', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.cwd', () => ({ value: '/r' }))
    const tree: Record<string, string> = {
      '/r/.claude/plans/x.md': 'Plan Version #1\nPlan Version #1 — Review #1 eingearbeitet\n',
      '/r/.claude/plans/x.review.md': 'Review Version #1\n',
    }
    files(on, tree)
    on('tool.call', (_$: unknown, e: { tool: string; file_path?: string; content?: string }) => {
      if (e.tool === 'Write' && e.file_path) tree[e.file_path] = e.content ?? ''
      return { result: {} }
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/.claude/plans/x.md'] })
    await $.tool.call({ tool: 'Write', file_path: '/r/.claude/plans/x.review.md', content: 'Review Version #2\n' })
    const all = await texts(await $.ui.mount({ ...PANE, surface: 'terminal' }))
    expect(all).not.toContain('ist da')
    expect(all).toContain('Review #2 einarbeiten')
  })

  test('the log shows the latest answer folded and all of them open', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, open_decisions: ['Staging zuerst?', 'Welcher Editor?'] })
    await $.tool.call({ tool: TOOL, decide: [{ id: 'd1', answer: 'ja' }] })
    await $.tool.call({ tool: TOOL, decide: [{ id: 'd2', answer: 'VS Code' }] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('ENTSCHIEDEN')
      expect(all).toContain('Welcher Editor?')
      expect(all).toContain('VS Code')
      expect(all).not.toContain('Staging zuerst?')
      await ui.press({ key: 'toggle-log' })
      expect(await texts(ui)).toContain('Staging zuerst?')
      await ui.press({ key: 'toggle-log' })
      await ui.unmount()
    }
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

  test('own notes are kept per repository and branch; the board itself is not', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    git(on)
    const store: Record<string, unknown> = {}
    memoryStore(on, store)
    await $.tool.call({ tool: TOOL, thread: { title: 'Payment v3', goal: 'Stripe fertig.' } })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.input({ key: 'note-input-0', text: 'Kunde anrufen' })
    expect(store['board:/r:feature/pay']).toMatchObject({ notes: [{ text: 'Kunde anrufen', isDone: false }] })
    expect(JSON.stringify(store)).not.toContain('Payment v3')
  })

  test('a new session brings the notes back, offers no earlier board, and asks nothing', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    git(on)
    // A board saved by an earlier version: its notes come back, the rest stays behind
    const store: Record<string, unknown> = {
      'board:/r:feature/pay': {
        branch: 'feature/pay',
        savedAt: Date.now(),
        board: { thread: { title: 'Payment v3', goal: 'Stripe fertig.' }, topic: null, todos: [], decisions: [], artifacts: [], log: [] },
        plans: [],
        notes: [{ id: 'n1', text: 'Kunde anrufen', isDone: false, at: 1 }],
      },
    }
    memoryStore(on, store)
    engineStart(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const all = await texts(await $.ui.mount({ ...PANE, surface: 'terminal' }))
    expect(all).toContain('Kunde anrufen')
    expect(all).not.toContain('Weitermachen')
    expect(all).not.toContain('Payment v3')
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    expect(sections.at(-1)?.text).not.toContain('Weitermachen')
  })

  test('the terminal frames the board and draws each rule to the exact width', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, thread: { title: 'T', goal: 'G' } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const root = await ui.find({ type: 'Box' })
    expect(root?.props.borderStyle).toBe('round')
    // The frame fills the pane's height
    expect(root?.props.minHeight).toBe(60)
    // bodyColumns 52 → inner 48; "WORUM ES GEHT " is 14 cells, so the rule is 34
    const rule = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^─+$/.test(t))
    expect(rule?.length).toBe(34)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await desktop.find({ type: 'Box' }))?.props.borderStyle).toBeUndefined()
  })

  test('the empty pane invites a topic', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)
    expect(all).toContain('Noch kein Thema')
    // The placeholder is a plain line, not a frame inside the frame
    expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle).length).toBe(1)
    // Empty questions and todos collapse into one quiet line
    expect(all).toContain('Keine offenen Fragen, keine Todos.')
    expect(all).not.toContain('TODOS')
  })

  test('the clear button drops finished todos', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, add_todos: ['a', 'b'] })
    await $.tool.call({ tool: TOOL, done_todos: ['t1'] })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'clear-done' })
    expect(await texts(ui)).not.toContain('erledigt')
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
