// Fokusboard: the current topic, open decisions and todos in a side pane.
// Board logic (todos, decisions, the Stop nudge) follows sirkitree/pinboard (MIT).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Todo, Topic } from '../types'

const PANE = 'fokusboard'
const TITLE = 'Fokusboard'
const TOOL = 'mcp__fokusboard__update'

const topic = atom({ plugin: 'fokusboard', key: 'topic' } as const, null as Topic | null)
const decisions = atom({ plugin: 'fokusboard', key: 'decisions' } as const, [] as Decision[])
const todos = atom({ plugin: 'fokusboard', key: 'todos' } as const, [] as Todo[])

const DESCRIPTION = [
  "Keep the user's Fokusboard current: a sidebar that stays in view while the transcript scrolls, showing the current topic, open decisions and the task list.",
  'topic: set it when a conversation gets a subject, and update it whenever the subject shifts or your understanding changes materially (a decision made, a cause found, a plan agreed).',
  'topic.title: 2-6 words. topic.summary: 1-3 short sentences on where things stand now, not a history. topic.points: up to 5 terse key facts or constraints worth keeping in view.',
  "Write the topic in the user's language.",
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
  add_todos?: string[]
  start_todo?: string
  done_todos?: string[]
  remove_todos?: string[]
  clear_done?: boolean
  open_decisions?: string[]
  decide?: { id: string; answer: string }[]
}

export type Board = { topic: Topic | null; todos: Todo[]; decisions: Decision[] }

// The next id for a prefix: one past the highest in use
const nextId = (prefix: string, ids: string[]) =>
  prefix + (Math.max(0, ...ids.map(id => Number(id.slice(prefix.length)) || 0)) + 1)

export function applyUpdate(board: Board, change: Update): Board {
  let { topic: tp, todos: t, decisions: d } = board
  if (change.topic) {
    tp = {
      title: change.topic.title.trim(),
      summary: change.topic.summary.trim(),
      points: (change.topic.points ?? []).map(p => p.trim()).filter(Boolean).slice(0, 5),
    }
  }
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
  return { topic: tp, todos: t, decisions: d }
}

export function describeBoard(board: Board): string {
  const lines = ['Fokusboard now:']
  if (board.topic) {
    lines.push(`Topic: ${board.topic.title}: ${board.topic.summary}`)
    lines.push(...board.topic.points.map(p => `  - ${p}`))
  } else {
    lines.push('Topic: (none yet; set it with topic once the conversation has a subject)')
  }
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
})

const isEmpty = (b: Board) => !b.topic && b.todos.length + b.decisions.length === 0

export function summarize(change: Update): string {
  const parts = [
    change.topic && `topic "${change.topic.title}"`,
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fokus', description: 'Open the Fokusboard: current topic, open decisions, todos', immediate: true })
    await $.tool.register({ name: 'update', description: DESCRIPTION, inputSchema: SCHEMA })
    return next(e)
  })

  on('command.run', { command: 'fokus' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return {}
  })

  // The board rides at the end of the system prompt, so it never has to be repeated in replies
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return { sections: [...sections, { id: 'fokusboard:board', text: describeBoard(await readBoard($)), scope: 'session' }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { deny: 'Only the main conversation updates the Fokusboard.' }
    const before = await readBoard($)
    const board = applyUpdate(before, e as Update)
    await update($, topic, () => board.topic)
    await update($, todos, () => board.todos)
    await update($, decisions, () => board.decisions)
    // Opens by itself the first time something lands on an empty board
    if (isEmpty(before) && !isEmpty(board)) await $.ui.open({ id: PANE, title: TITLE })
    return { result: describeBoard(board) }
  })

  // A question left only in the reply scrolls away; send Claude back once to pin it
  on('classic.Stop', async ($, e, next) => {
    const ran = await next(e)
    if (ran.block || e.stop_hook_active || !asksUser(e.last_assistant_message ?? '')) return ran
    if ((await read($, decisions)).length > 0) return ran
    return { ...ran, block: NUDGE }
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
    const { Box, Text, Button } = $.ui.resolve(e)
    // One cell of padding on every side
    const inner = Math.max(10, e.props.bodyColumns - 2)
    const { topic: tp, todos: allTodos, decisions: allDecisions } = await readBoard($)
    const doneCount = allTodos.filter(t => t.isDone).length

    const header = (title: string, count: string, color?: string) => (
      <Text bold color={color}>
        {title} <Text dimColor>{count}</Text>
      </Text>
    )
    const empty = (text: string) => <Text dimColor>  {text}</Text>
    // The bullet stays in its own column, so wrapped lines indent under the text
    const item = (bullet: string, text: string, width: number, isDim = false, color?: string) => (
      <Box flexDirection="row" width={width}>
        <Text dimColor={isDim} color={color}>{'  ' + bullet + ' '}</Text>
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
        <Text bold color="claude" wrap="wrap">
          {'◆ ' + tp.title}
        </Text>
        <Box width={card}>
          <Text wrap="wrap">{tp.summary}</Text>
        </Box>
        {tp.points.length > 0 && <Text> </Text>}
        {tp.points.map(p => (
          <Box flexDirection="row" width={card}>
            <Text color="claude">{'› '}</Text>
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

    return (
      <Box flexDirection="column" width={inner + 2} padding={1}>
        {topicCard}
        <Text> </Text>

        {header('Offene Entscheidungen', allDecisions.length ? String(allDecisions.length) : '', allDecisions.length ? 'warning' : undefined)}
        {allDecisions.length === 0 && empty('Nichts offen.')}
        {allDecisions.map(d => item('?', d.text, inner, false, 'warning'))}
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
