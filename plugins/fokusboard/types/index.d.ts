export type Todo = { id: string; text: string; isDone: boolean; isActive?: boolean }

export type Decision = { id: string; text: string }

export type Topic = { title: string; summary: string; points: string[] }

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
      topic: Topic | null
      decisions: Decision[]
      todos: Todo[]
      artifacts: Artifact[]
      mode: string | null
      plans: string[]
      planStatus: PlanStatus[]
      lastCodeEditAt: number
    }
  }
}
