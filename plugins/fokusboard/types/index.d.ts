// startedAt: when it became the active one, for "seit 3 min"
export type Todo = { id: string; text: string; isDone: boolean; isActive?: boolean; startedAt?: number }

// How much an open question holds up the work: blocking stops it, optional can wait
export type Weight = 'blocking' | 'important' | 'optional'

// An open question for the person; context, options and the recommendation help them decide
export type Decision = {
  id: string
  text: string
  context?: string
  options?: string[]
  // One short line per option on what it does, same order as options ('' where none)
  notes?: string[]
  recommended?: string
  weight?: Weight
  // When it was opened, to tell whether a turn put its question on the board
  at?: number
}

// What the whole conversation is about; stable, changed only when the overall goal changes
export type Thread = { title: string; goal: string }

// at: when this subject began (kept while only the summary changes)
export type Topic = { title: string; summary: string; points: string[]; at?: number }

// An earlier topic of the session, for the dots beside the thread title
export type TopicMark = { title: string; at: number }

// A prompt the person sends again and again; {plan} stands for the open plan's path
export type Griff = { label: string; text: string }

// An answered decision, kept so later work can see why things are as they are; openedAt: when it was asked
export type LogEntry = { text: string; answer: string; at: number; openedAt?: number }

// A session's board as it last stood, so a resumed session (same id) gets it back
export type SavedBoard = {
  at: number
  thread: Thread | null
  topic: Topic | null
  decisions: Decision[]
  todos: Todo[]
  artifacts: Artifact[]
  log: LogEntry[]
  plans: string[]
  trail?: TopicMark[]
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
      // Finished todos folded away in the pane
      hideDone: boolean
      // Earlier topics of this session, oldest first
      trail: TopicMark[]
      // The person's saved prompts (kept across sessions in the store)
      griffe: Griff[]
      // When the current turn began, to tell whether it put its questions on the board
      turnStartAt: number
    }
  }
}
