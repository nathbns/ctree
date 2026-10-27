/** The commits the refs pointed at when the session started. */
export type CtreeBaseline = string[]

/** Where HEAD stands: on a branch, or detached (no branch); no commit yet is a null hash. */
export type CtreeHead = { branch: string | null; hash: string | null }

/** Every branch, tag and remote branch by full name (`refs/heads/main`), and HEAD. */
export type CtreeRefState = { refs: Record<string, string>; head: CtreeHead }

/** One ref a git command moved: null before when it made it, null after when it deleted it. */
export type CtreeRefMove = { ref: string; before: string | null; after: string | null }

/** One git command Claude ran that changed refs or threw changes away. */
export type CtreeJournalEntry = {
  id: string
  /** Milliseconds since the epoch. */
  at: number
  /** The conversation's prompt count when it ran. */
  turn: number
  /** The command as Claude wrote it, cut to 200 characters. */
  command: string
  /** Run by a subagent rather than the main conversation. */
  isSubagent: boolean
  moves: CtreeRefMove[]
  head: { before: CtreeHead; after: CtreeHead }
  /** `git stash create` of the tracked changes it was about to throw away. */
  saved?: string
  savedFiles?: number
  isUndone?: true
}

/** The refs when the session started, for the session view. */
export type CtreeStart = CtreeRefState & { at: number }

declare module 'claude-code' {
  interface PluginState {
    ctree: {
      baseline: CtreeBaseline | null
      start: CtreeStart | null
      journal: CtreeJournalEntry[]
    }
  }
}
