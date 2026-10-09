import { describe, expect, test } from 'claude-code/testing'

import { applyUpdate, asksUser, describeBoard, summarize } from '../hooks/register'

const SURFACES = ['terminal', 'desktop'] as const
const TOOL = 'mcp__fokusboard__update'
const PANE = {
  plugin: 'fokusboard',
  component: 'Pane',
  requestId: 'fokusboard',
  props: {
    title: 'Fokusboard',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const EMPTY = { topic: null, todos: [], decisions: [] }

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

describe('board', () => {
  test('topic is set, trimmed, capped at five points and replaced as a whole', () => {
    let board = applyUpdate(EMPTY, {
      topic: { title: ' Stripe-Abgleich ', summary: 'Webhooks fehlen noch.', points: ['a', ' ', 'b', 'c', 'd', 'e', 'f'] },
    })
    expect(board.topic).toEqual({ title: 'Stripe-Abgleich', summary: 'Webhooks fehlen noch.', points: ['a', 'b', 'c', 'd', 'e'] })
    board = applyUpdate(board, { topic: { title: 'Neu', summary: 'Anders.' } })
    expect(board.topic).toEqual({ title: 'Neu', summary: 'Anders.', points: [] })
    // Other changes leave the topic alone
    expect(applyUpdate(board, { add_todos: ['x'] }).topic?.title).toBe('Neu')
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

  test('the board reads back with topic and ids', () => {
    expect(describeBoard(EMPTY)).toContain('Topic: (none yet')
    expect(
      describeBoard({
        topic: { title: 'T', summary: 'S', points: ['p'] },
        todos: [{ id: 't1', text: 'Write', isDone: false, isActive: true }],
        decisions: [{ id: 'd1', text: 'Which?' }],
      }),
    ).toBe('Fokusboard now:\nTopic: T: S\n  - p\nt1 [>] Write\nd1 [?] Which?')
  })

  test('questions at the end of a reply are detected outside code', () => {
    expect(asksUser('Gespeichert.\n\nSoll ich das löschen?')).toBe(true)
    expect(asksUser('Run:\n\n```\necho ok?\n```')).toBe(false)
  })

  test('the transcript line names what changed', () => {
    expect(summarize({ topic: { title: 'X', summary: 'y' }, add_todos: ['a'], decide: [{ id: 'd1', answer: 'z' }] })).toBe(
      'Fokusboard: topic "X", +1 todo, 1 decided',
    )
  })
})

describe('session', () => {
  test('the tool fills the pane with a topic card, decisions and todos', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
    await $.tool.call({
      tool: TOOL,
      topic: { title: 'Payment v3', summary: 'Checkout läuft, Rückgabeseite fertig.', points: ['Stripe Sandbox'] },
      add_todos: ['Webhook testen', 'Deploy'],
      open_decisions: ['Staging zuerst?'],
    })
    await $.tool.call({ tool: TOOL, done_todos: ['t1'], start_todo: 't2' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const all = await texts(ui)
      expect(all).toContain('◆ Payment v3')
      expect(all).toContain('Checkout läuft, Rückgabeseite fertig.')
      expect(all).toContain('Stripe Sandbox')
      expect(all).toContain('? Staging zuerst?')
      expect(all).toContain('▸ Deploy')
      expect(all).toContain('✓ 1 erledigt')
      expect(all).not.toContain('Webhook testen')
      await ui.unmount()
    }
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    expect(sections.at(-1)?.text).toContain('Topic: Payment v3')
  })

  test('the empty pane invites a topic', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await texts(ui)).toContain('Noch kein Thema')
  })

  test('the clear button drops finished todos', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.tool.call({ tool: TOOL, add_todos: ['a', 'b'], done_todos: [] })
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
