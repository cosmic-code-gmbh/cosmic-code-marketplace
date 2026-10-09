export type Todo = { id: string; text: string; isDone: boolean; isActive?: boolean }

export type Decision = { id: string; text: string }

// What the whole conversation is about; stable, changed only when the overall goal changes
export type Thread = { title: string; goal: string }

export type Topic = { title: string; summary: string; points: string[] }

// An answered decision, kept so later work can see why things are as they are
export type LogEntry = { text: string; answer: string; at: number }

// Something that changed in a tracked plan outside this session and asks for a step
export type Notice = { path: string; name: string; kind: 'review' | 'gaps' | 'verified'; label: string; at: number }

// The board as saved per repository and branch, offered back in a later session
export type Snapshot = {
  branch: string
  savedAt: number
  board: { thread: Thread | null; topic: Topic | null; todos: Todo[]; decisions: Decision[]; artifacts: Artifact[]; log: LogEntry[] }
  plans: string[]
}

// A link that matters for the current work: a claude.ai artifact, a PR, a doc
export type Artifact = { label: string; href: string }

// The plan workflow: Plan → Review → Einarbeiten → Umsetzen → Verify
export type Step = 'plan' | 'review' | 'integrate' | 'implement' | 'verify' | 'done'

// What the version headers in <plan>.md, .review.md and .verify.md say
export type PlanStatus = {
  path: string
  name: string
  exists: boolean
  planVersion: number | null
  integratedReview: number | null
  latestReview: number | null
  verifiedVersion: number | null
  verifyResult: 'vollständig' | 'Lücken' | 'unvollständig' | null
  hasReview: boolean
  hasVerify: boolean
  // Newest mtime of the plan and its review, to tell "ready" from "being implemented"
  planMtime: number
}

declare module 'claude-code' {
  interface PluginState {
    fokusboard: {
      thread: Thread | null
      topic: Topic | null
      decisions: Decision[]
      todos: Todo[]
      artifacts: Artifact[]
      mode: string | null
      plans: string[]
      planStatus: PlanStatus[]
      lastCodeEditAt: number
      log: LogEntry[]
      showLog: boolean
      notices: Notice[]
      offer: Snapshot | null
    }
  }
}
