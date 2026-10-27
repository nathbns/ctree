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
  /**
   * A merge whose other parents were left out (a first-parent log draws
   * the branch's own line): still drawn ○.
   */
  isMerge?: true
  /** A stash drawn on the commit it was made on: its selector (`stash@{0}`). */
  stash?: string
}

/** A stash entry: its own commit, whose first parent is where HEAD stood. */
export type Stash = {
  hash: string
  /** The commit it was made on. */
  base: string
  /** `stash@{0}`, newest first. */
  selector: string
  author: string
  email: string
  time: number
  /** `WIP on main: 1a2b3c4 …`, or `On main: <message>`. */
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

/** Which history the log reads: every branch, or one ref's (focus). */
export type LogScope =
  | { kind: 'all' }
  | {
      kind: 'focus'
      /** A full ref name (`refs/heads/main`) or a commit hash. */
      ref: string
      /** What the header calls it (`main`). */
      label: string
      /** Only the first parent of each merge: the branch's own line. */
      isFirstParent: boolean
    }

export type RepoSnapshot = {
  kind: 'repo'
  repo: RepoInfo
  head: HeadState
  refs: readonly Ref[]
  commits: readonly Commit[]
  /** More commits exist past the ones loaded. */
  hasMore: boolean
  /** The history the commits were read from. */
  scope: LogScope
  status: readonly StatusEntry[]
  worktrees: readonly Worktree[]
  stashes: readonly Stash[]
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
  options?: GitOptions,
) => Promise<GitResult>

export type GitOptions = {
  cwd?: string
  stdin?: string
  /** Set over the environment, for the network commands' ssh. */
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
}

export type GitResult = { code: number; stdout: string; stderr: string }
