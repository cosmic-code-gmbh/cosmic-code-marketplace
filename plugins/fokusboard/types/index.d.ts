export type Todo = { id: string; text: string; isDone: boolean; isActive?: boolean }

// How much an open question holds up the work: blocking stops it, optional can wait
export type Weight = 'blocking' | 'important' | 'optional'

// An open question for the person; context, options and the recommendation help them decide
export type Decision = {
  id: string
  text: string
  context?: string
  options?: string[]
  recommended?: string
  weight?: Weight
  // When it was opened, to tell whether a turn put its question on the board
  at?: number
}

// What the whole conversation is about; stable, changed only when the overall goal changes
export type Thread = { title: string; goal: string }

export type Topic = { title: string; summary: string; points: string[] }

// The person's own note or todo; Claude reads these but never changes them
export type Note = { id: string; text: string; isDone: boolean; at: number }

// An answered decision, kept so later work can see why things are as they are
export type LogEntry = { text: string; answer: string; at: number }

// Something that changed in a tracked plan outside this session and asks for a step
export type Notice = { path: string; name: string; kind: 'review' | 'gaps' | 'verified'; label: string; at: number }

// What is kept per repository and branch across sessions: the person's own notes
export type Saved = { notes?: Note[] }

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
  // The integrated review was only partly worked in (open points wait on the person)
  isPartial?: boolean
  latestReview: number | null
  // Who wrote the latest review ("Sol, Runde 2") and against which plan version
  reviewBy?: string | null
  reviewedVersion?: number | null
  // Findings of the latest review by severity
  findings?: { critical: number; important: number; optional: number }
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
      notes: Note[]
      // When the current turn began, to tell whether it put its questions on the board
      turnStartAt: number
      // Plans whose review or verify file this session wrote itself (a sol loop): no notice for those
      ownWrites: { path: string; at: number }[]
    }
  }
}
