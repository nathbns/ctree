// Shared shapes of the pure core. Nothing here knows about Claude Code.

/** One commit as `git log` reports it. */
export type Commit = {
  hash: string
  parents: readonly string[]
  author: string
  email: string
  /** Author date, seconds since the epoch. */
  time: number
  subject: string
}

export type RefKind = 'branch' | 'remote' | 'tag'

/** A branch, remote-tracking branch or tag, peeled to the commit it names. */
export type Ref = {
  kind: RefKind
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string
  /** The commit it points at. */
  target: string
  /** For a local branch: its upstream's short name (`origin/main`). */
  upstream?: string
  /** For a local branch: `[ahead, behind]` against its upstream. */
  track?: readonly [number, number]
  /** For a local branch: its upstream was deleted. */
  isUpstreamGone?: boolean
}

export type HeadState =
  | { kind: 'branch'; branch: string; hash: string | null }
  | { kind: 'detached'; hash: string }

export type Worktree = {
  path: string
  head: string | null
  /** Short branch name, absent when detached or bare. */
  branch?: string
}

/** A path the working tree changes, as `git status` reports it. */
export type StatusEntry = {
  path: string
  oldPath?: string
  /** M, A, D, R, C, T, U (unmerged) or ? (untracked). */
  code: string
}

/** A file a commit (or the working tree) changes, with its line counts. */
export type FileChange = {
  /** M, A, D, R, C, T, U, or ? for an untracked file. */
  status: string
  path: string
  oldPath?: string
  /** null when git counts it as binary. */
  added: number | null
  deleted: number | null
}

export type RepoInfo = {
  toplevel: string
  /** Basename of the top level. */
  name: string
  gitDir: string
  commonDir: string
  /** A linked worktree (`git worktree add`), not the main one. */
  isLinkedWorktree: boolean
}

export type RepoSnapshot = {
  kind: 'repo'
  repo: RepoInfo
  head: HeadState
  refs: readonly Ref[]
  commits: readonly Commit[]
  /** More commits exist past the ones loaded. */
  hasMore: boolean
  status: readonly StatusEntry[]
  worktrees: readonly Worktree[]
  /** Commits this session created (rebased ones included). */
  sessionCommits: readonly string[]
}

export type Snapshot =
  | RepoSnapshot
  | { kind: 'no-repo'; cwd: string; reason: 'outside' | 'bare' }
  | { kind: 'error'; cwd: string; message: string }

/** Runs `git <args>` and resolves whatever the exit code. */
export type GitRunner = (
  args: readonly string[],
  options?: { cwd?: string; stdin?: string },
) => Promise<GitResult>

export type GitResult = { code: number; stdout: string; stderr: string }
