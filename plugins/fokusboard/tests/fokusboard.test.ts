import { describe, expect, test } from 'claude-code/testing'

import type { PlanStatus } from '../types'
import { applyUpdate, asksUser, describeBoard, parseHeaders, pipeline, planOf, stageOf, summarize } from '../hooks/register'

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

const EMPTY = { thread: null, topic: null, todos: [], decisions: [], artifacts: [] }

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

  test('artifacts are added by href without duplicates and removed by href', () => {
    let board = applyUpdate(EMPTY, { add_artifacts: [{ label: 'PR #12', href: 'https://x/pr/12' }, { label: 'Doc', href: 'https://x/doc' }] })
    board = applyUpdate(board, { add_artifacts: [{ label: 'PR #12 (neu)', href: 'https://x/pr/12' }], remove_artifacts: ['https://x/doc'] })
    expect(board.artifacts).toEqual([{ label: 'PR #12 (neu)', href: 'https://x/pr/12' }])
  })

  test('the board reads back with topic, plans and ids', () => {
    expect(describeBoard(EMPTY)).toContain('Thread: (none yet')
    expect(describeBoard(EMPTY)).toContain('Topic: (none yet')
    expect(
      describeBoard(
        { thread: null, topic: { title: 'T', summary: 'S', points: ['p'] }, todos: [{ id: 't1', text: 'Write', isDone: false, isActive: true }], decisions: [{ id: 'd1', text: 'Which?' }], artifacts: [] },
        [status({ hasReview: true, latestReview: 2, integratedReview: 1 })],
        'plan',
      ),
    ).toBe('Fokusboard now:\nThread: (none yet; set thread with the overall goal of this conversation)\nTopic: T: S\n  - p\nMode: plan mode\nPlan /r/docs/x.md: Review #2 einarbeiten\nt1 [>] Write\nd1 [?] Which?')
  })

  test('questions at the end of a reply are detected outside code', () => {
    expect(asksUser('Gespeichert.\n\nSoll ich das löschen?')).toBe(true)
    expect(asksUser('Run:\n\n```\necho ok?\n```')).toBe(false)
  })

  test('the transcript line names what changed', () => {
    expect(summarize({ topic: { title: 'X', summary: 'y' }, track_plans: ['a'], add_todos: ['a'], decide: [{ id: 'd1', answer: 'z' }] })).toBe(
      'Fokusboard: topic "X", +1 plan, +1 todo, 1 decided',
    )
  })
})

describe('plan workflow', () => {
  test('headers are read as docs/plan-workflow.md writes them', () => {
    const plan = '# Plan Version #3\n…\nPlan Version #2 — Review #1 eingearbeitet\nPlan Version #3 — Review #2 eingearbeitet\n'
    const review = 'Review Version #1\n…\nReview Version #3\n'
    const verify = 'Verifikation gegen Plan Version #2 — Ergebnis: Lücken\n…\nVerifikation gegen Plan Version #3 — Ergebnis: **vollständig**\n'
    expect(parseHeaders(plan, review, verify)).toEqual({
      planVersion: 3,
      integratedReview: 2,
      latestReview: 3,
      verifiedVersion: 3,
      verifyResult: 'vollständig',
    })
    expect(parseHeaders('', '', '')).toEqual({ planVersion: null, integratedReview: null, latestReview: null, verifiedVersion: null, verifyResult: null })
  })

  test('review and verify files belong to their plan', () => {
    expect(planOf('/r/docs/a/x.review.md')).toBe('/r/docs/a/x.md')
    expect(planOf('/r/docs/a/x.verify.md')).toBe('/r/docs/a/x.md')
    expect(planOf('/r/docs/a/x.md')).toBe('/r/docs/a/x.md')
  })

  test('each state of the workflow maps to its step', () => {
    expect(stageOf(status({ exists: false }), 0)).toEqual({ step: 'plan', label: 'Plan wird erstellt', tone: 'busy' })
    expect(stageOf(status({}), 0).step).toBe('review')
    expect(stageOf(status({ hasReview: true, latestReview: 2, integratedReview: 1 }), 0).label).toBe('Review #2 einarbeiten')
    const settled = status({ hasReview: true, latestReview: 2, integratedReview: 2 })
    expect(stageOf(settled, 50).label).toBe('bereit zur Umsetzung')
    expect(stageOf(settled, 500).label).toBe('Umsetzung läuft')
    const verified = { ...settled, hasVerify: true, planVersion: 3 }
    expect(stageOf({ ...verified, verifiedVersion: 2, verifyResult: 'vollständig' }, 0).label).toBe('Verify veraltet (gegen v2)')
    expect(stageOf({ ...verified, verifiedVersion: 3, verifyResult: 'Lücken' }, 0).label).toBe('Nachbessern: Lücken')
    expect(stageOf({ ...verified, verifiedVersion: 3, verifyResult: 'vollständig' }, 0)).toEqual({ step: 'done', label: 'vollständig verifiziert', tone: 'ok' })
  })

  test('the pipeline marks passed, current and ahead steps', () => {
    expect(pipeline('integrate').map(x => x.state)).toEqual(['passed', 'passed', 'current', 'ahead', 'ahead'])
    expect(pipeline('done').every(x => x.state === 'passed')).toBe(true)
  })
})

describe('session', () => {
  test('the tool fills the pane with a topic card, decisions and todos', async ($, on) => {
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
      // The anchor comes before the current step
      expect(all.indexOf('Payment v3 fertigstellen')).toBeLessThan(all.indexOf('AKTUELL'))
      expect(all).toContain('Checkout läuft, Rückgabeseite fertig.')
      expect(all).toContain('Stripe Sandbox')
      expect(all).toContain('◇')
      expect(all).toContain('Staging zuerst?')
      expect(all).toContain('Deploy')
      expect(all).toContain('✓ 1 erledigt')
      expect(all).toContain('TODOS')
      expect(all).toContain('1/2')
      expect(all).toContain('▰▰▰▰▰')
      expect(all).toContain('WORUM ES GEHT')
      expect(all).not.toContain('Webhook testen')
      // No plan tracked and not in plan mode: no workflow section
      expect(all).not.toContain('PLAN-WORKFLOW')
      await ui.unmount()
    }
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    expect(sections.at(-1)?.text).toContain('Thread: Payment v3 fertigstellen')
    expect(sections.at(-1)?.text).toContain('Topic: Payment v3')
    // A thread rewrite without why is refused and says so
    const refused = await $.tool.call({ tool: TOOL, thread: { title: 'Anderes', goal: 'x' } })
    expect('result' in refused && refused.result).toContain('Thread unchanged')
  })

  test('a tracked plan shows its pipeline, review and verify status and links its files', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    files(on, {
      '/r/docs/pay/stripe.md': 'Plan Version #2\n…\nPlan Version #2 — Review #1 eingearbeitet\n',
      '/r/docs/pay/stripe.review.md': 'Review Version #1\nReview Version #2\n',
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/docs/pay/stripe.md'], add_artifacts: [{ label: 'Checkout-Mockup', href: 'https://claude.ai/artifact/abc' }] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('PLAN-WORKFLOW')
      expect(all).toContain('stripe')
      expect(all).toContain('◉ Einarb.')
      expect(all).toContain('Review #2 einarbeiten')
      expect(all).toContain('#2 offen')
      expect(all).toContain('ARTEFAKTE')
      expect((await ui.findAll({ type: 'Link' })).map(l => [l.props.label, l.props.href])).toContainEqual(['Checkout-Mockup', 'https://claude.ai/artifact/abc'])
      const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      if (surface === 'terminal') {
        expect(hrefs).toContain('file:///r/docs/pay/stripe.md')
        expect(hrefs).toContain('file:///r/docs/pay/stripe.review.md')
      } else {
        // The desktop draws no file:// link: a button opens the file instead
        expect(buttons).toContain('Plan v2')
        expect(buttons).toContain('Review #2')
      }
      // No verify file yet: plain text, nothing to open
      expect(buttons).not.toContain('Verify')
      expect(hrefs).not.toContain('file:///r/docs/pay/stripe.verify.md')
      await ui.unmount()
    }
  })

  test('a desktop click opens the plan file with open', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    files(on, { '/r/docs/x.md': 'Plan Version #1\n' })
    const ran: string[][] = []
    on('process.run', (_$: unknown, e: { argv: string[] }) => {
      ran.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    await $.tool.call({ tool: TOOL, track_plans: ['/r/docs/x.md'] })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open:/r/docs/x.md' })
    expect(ran).toEqual([['open', '/r/docs/x.md']])
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
    await $.tool.call({ tool: TOOL, open_decisions: ['Staging zuerst?', 'Welcher Editor?'] })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(buttons).toContain('↩ Antworten')
      expect(buttons).toContain('? Frag mich')
      expect(buttons).toContain('Alle Fragen stellen')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'reply:d1' })
    expect(filled).toEqual(['Zu „Staging zuerst?“: '])
    await ui.press({ key: 'ask:d2' })
    expect(sent.at(-1)).toContain('d2: Welcher Editor?')
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

  test('the empty pane invites a topic', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)
    expect(all).toContain('Noch kein Thema')
    // Empty decisions and todos collapse into one quiet line
    expect(all).toContain('Keine offenen Entscheidungen, keine Todos.')
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

  test('a question left only in the reply sends Claude back once', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('classic.Stop', () => ({}))
    const asking = { stop_hook_active: false, last_assistant_message: 'Fertig.\n\nSoll ich deployen?' }
    expect((await $.classic.Stop(asking)).block).toContain('open_decisions')
    expect((await $.classic.Stop({ ...asking, stop_hook_active: true })).block).toBeUndefined()
  })
})
