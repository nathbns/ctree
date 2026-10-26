// Loads what the pane shows through an injected git runner, so the same code
// runs under Claude Code ($.process.run) and in tests (a scripted git).

import * as Cmd from './git-commands'
import {
  hunksOf,
  joinChanges,
  parseHead,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRepoInfo,
  parseStatus,
  parseWorktrees,
} from './git-parse'
import type { Commit, FileChange, GitRunner, RepoSnapshot, Snapshot, StatusEntry } from './types'

/**
 * The repository at `cwd`: HEAD, refs, the first `count` commits, the
 * working tree's status and worktrees, and which commits the session made
 * (`baseline`: the commits the refs pointed at when it started).
 */
export async function loadSnapshot(
  git: GitRunner,
  cwd: string,
  options: { count: number; baseline: readonly string[] | null },
): Promise<Snapshot> {
  try {
    const info = await git(Cmd.repoInfo(), { cwd })

    if (info.code !== 0) {
      const isBare = /must be run in a work tree/.test(info.stderr)

      return /not a git repository/i.test(info.stderr) || isBare
        ? { kind: 'no-repo', cwd, reason: isBare ? 'bare' : 'outside' }
        : { kind: 'error', cwd, message: firstLine(info.stderr) }
    }

    const repo = parseRepoInfo(info.stdout)

    if (!repo) {
      return { kind: 'error', cwd, message: 'réponse inattendue de git rev-parse' }
    }

    const at = { cwd: repo.toplevel }
    const [symbolic, commit, refs, status, trees, email] = await Promise.all([
      git(Cmd.headRef(), at),
      git(Cmd.headCommit(), at),
      git(Cmd.refs(), at),
      git(Cmd.status(), at),
      git(Cmd.worktrees(), at),
      git(Cmd.userEmail(), at),
    ])
    const head = parseHead(symbolic, commit)
    const refList = refs.code === 0 ? parseRefs(refs.stdout) : []
    const hasHistory = head.hash !== null || refList.length > 0
    const page = hasHistory
      ? await loadCommits(git, repo.toplevel, { skip: 0, count: options.count, withHead: head.hash !== null })
      : { commits: [], hasMore: false }
    const sessionCommits =
      options.baseline !== null && hasHistory
        ? await loadSessionCommits(git, repo.toplevel, {
            baseline: options.baseline,
            withHead: head.hash !== null,
            email: email.code === 0 ? email.stdout.trim() : undefined,
          })
        : []

    return {
      kind: 'repo',
      repo,
      head,
      refs: refList,
      commits: page.commits,
      hasMore: page.hasMore,
      status: status.code === 0 ? parseStatus(status.stdout) : [],
      worktrees: trees.code === 0 ? parseWorktrees(trees.stdout) : [],
      sessionCommits,
    }
  } catch (error) {
    return { kind: 'error', cwd, message: messageOf(error) }
  }
}

/** One page of history. */
export async function loadCommits(
  git: GitRunner,
  toplevel: string,
  options: { skip: number; count: number; withHead: boolean },
): Promise<{ commits: Commit[]; hasMore: boolean }> {
  const result = await git(Cmd.log(options), { cwd: toplevel })

  if (result.code !== 0) {
    throw new Error(firstLine(result.stderr) || 'git log a échoué')
  }

  const commits = parseLog(result.stdout)

  return { commits: commits.slice(0, options.count), hasMore: commits.length > options.count }
}

/** The page after the commits `snapshot` holds, appended; none twice. */
export async function loadMore(git: GitRunner, snapshot: RepoSnapshot): Promise<RepoSnapshot> {
  const page = await loadCommits(git, snapshot.repo.toplevel, {
    skip: snapshot.commits.length,
    count: Cmd.PAGE_SIZE,
    withHead: snapshot.head.hash !== null,
  })
  const known = new Set(snapshot.commits.map(commit => commit.hash))

  return {
    ...snapshot,
    commits: [...snapshot.commits, ...page.commits.filter(commit => !known.has(commit.hash))],
    hasMore: page.hasMore,
  }
}

/** The working tree's status alone, after an edit; null when git fails. */
export async function loadStatus(git: GitRunner, toplevel: string): Promise<StatusEntry[] | null> {
  const result = await git(Cmd.status(), { cwd: toplevel })

  return result.code === 0 ? parseStatus(result.stdout) : null
}

/** The commits every ref pointed at, for the session's baseline. */
export async function loadTips(git: GitRunner, cwd: string): Promise<string[]> {
  const [refs, head] = await Promise.all([git(Cmd.refs(), { cwd }), git(Cmd.headCommit(), { cwd })])
  const tips = new Set(refs.code === 0 ? parseRefs(refs.stdout).map(ref => ref.target) : [])

  if (head.code === 0 && head.stdout.trim()) {
    tips.add(head.stdout.trim())
  }

  return [...tips]
}

async function loadSessionCommits(
  git: GitRunner,
  toplevel: string,
  options: { baseline: readonly string[]; withHead: boolean; email?: string },
): Promise<string[]> {
  const result = await git(Cmd.sessionCommits(options), {
    cwd: toplevel,
    stdin: options.baseline.map(hash => `^${hash}\n`).join(''),
  })

  return result.code === 0 ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
}

/** The files a commit changes against its first parent, with line counts. */
export async function loadCommitFiles(git: GitRunner, toplevel: string, commit: Commit): Promise<FileChange[]> {
  const parent = commit.parents[0]
  const [statuses, counts] = await Promise.all([
    git(Cmd.commitNameStatus(commit.hash, parent), { cwd: toplevel }),
    git(Cmd.commitNumstat(commit.hash, parent), { cwd: toplevel }),
  ])

  if (statuses.code !== 0) {
    throw new Error(firstLine(statuses.stderr) || 'git diff-tree a échoué')
  }

  return joinChanges(parseNameStatus(statuses.stdout), counts.code === 0 ? parseNumstat(counts.stdout) : [])
}

/** Untracked files whose lines are counted; past these they show none. */
const UNTRACKED_COUNTED = 50

/** The working tree's changed files, with line counts against HEAD. */
export async function loadWipFiles(
  git: GitRunner,
  toplevel: string,
  status: readonly StatusEntry[],
  hasHead: boolean,
): Promise<FileChange[]> {
  const untracked = status.filter(entry => entry.code === '?').slice(0, UNTRACKED_COUNTED)
  const [counts, ...news] = await Promise.all([
    git(Cmd.worktreeNumstat(hasHead), { cwd: toplevel }),
    ...untracked.map(entry => git(Cmd.untrackedNumstat(entry.path), { cwd: toplevel })),
  ])
  const byPath = new Map((counts?.code === 0 ? parseNumstat(counts.stdout) : []).map(count => [count.path, count]))

  news.forEach((result, i) => {
    const count = parseNumstat(result.stdout)[0]
    const entry = untracked[i]

    if (count && entry) {
      byPath.set(entry.path, count)
    }
  })

  return status.map(entry => {
    const count = byPath.get(entry.path)
    const change: FileChange = {
      status: entry.code,
      path: entry.path,
      added: count ? count.added : 0,
      deleted: count ? count.deleted : 0,
    }

    if (entry.oldPath) {
      change.oldPath = entry.oldPath
    }

    return change
  })
}

export type Diff =
  | { kind: 'hunks'; source: string; isCut: boolean }
  | { kind: 'binary' }
  | { kind: 'empty' }

/** Characters of diff the pane draws at most. */
export const DIFF_LIMIT = 60_000

/** One file's diff in a commit, against its first parent. */
export async function loadCommitDiff(
  git: GitRunner,
  toplevel: string,
  commit: Commit,
  change: FileChange,
): Promise<Diff> {
  const result = await git(Cmd.commitFileDiff(commit.hash, commit.parents[0], change.path, change.oldPath), {
    cwd: toplevel,
  })

  return diffOf(result.stdout)
}

/** One file of the working tree against HEAD (whole, when git does not track it). */
export async function loadWipDiff(git: GitRunner, toplevel: string, change: FileChange): Promise<Diff> {
  const args = change.status === '?' ? Cmd.untrackedFileDiff(change.path) : Cmd.worktreeFileDiff(change.path, change.oldPath)
  const result = await git(args, { cwd: toplevel })

  return diffOf(result.stdout)
}

function diffOf(stdout: string): Diff {
  const hunks = hunksOf(stdout)

  if (hunks.kind !== 'hunks') {
    return hunks
  }

  if (hunks.source.length <= DIFF_LIMIT) {
    return { kind: 'hunks', source: hunks.source, isCut: false }
  }

  // Cut before the hunk that crosses the limit, so what is drawn still parses.
  const cut = hunks.source.lastIndexOf('\n@@ ', DIFF_LIMIT)

  return { kind: 'hunks', source: hunks.source.slice(0, cut > 0 ? cut : DIFF_LIMIT), isCut: true }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/^fatal: /, '') ?? ''
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return /ENOENT|not found|cannot start/i.test(text) ? 'git est introuvable sur cette machine' : text
}
