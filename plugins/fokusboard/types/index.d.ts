export type Todo = { id: string; text: string; isDone: boolean; isActive?: boolean }

export type Decision = { id: string; text: string }

export type Topic = { title: string; summary: string; points: string[] }

declare module 'claude-code' {
  interface PluginState {
    fokusboard: {
      topic: Topic | null
      decisions: Decision[]
      todos: Todo[]
    }
  }
}
