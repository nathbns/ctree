// Parsers for the outputs of the commands in git-commands.ts. Each one takes
// git's stdout as a string and never throws on odd input: it skips it.

import { FIELD } from './git-commands'
import type {
  Commit,
  FileChange,
  HeadState,
  Ref,
  RepoInfo,
  StatusEntry,
  Worktree,
} from './types'

/** `rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`. */
export function parseRepoInfo(stdout: string): RepoInfo | null {
  const [toplevel, gitDir, commonDir] = stdout.split('\n').map(line => line.trim())

  if (!toplevel || !gitDir || !commonDir) {
    return null
  }

  return {
    toplevel,
    name: basename(toplevel),
    gitDir,
    commonDir,
    isLinkedWorktree: stripSlash(gitDir) !== stripSlash(commonDir),
  }
}

/** `symbolic-ref -q HEAD` and `rev-parse -q --verify HEAD^{commit}`. */
export function parseHead(
  symbolic: { code: number; stdout: string },
  commit: { code: number; stdout: string },
): HeadState {
  const hash = commit.code === 0 ? commit.stdout.trim() || null : null
  const ref = symbolic.code === 0 ? symbolic.stdout.trim() : ''

  if (ref.startsWith('refs/heads/')) {
    return { kind: 'branch', branch: ref.slice('refs/heads/'.length), hash }
  }

  return hash === null
    ? { kind: 'branch', branch: ref || 'HEAD', hash: null }
    : { kind: 'detached', hash }
}

/** `log -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s`. */
export function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = []

  for (const record of stdout.split('\0')) {
    const fields = record.replace(/^\n+/, '').split(FIELD)
    const [hash, parents, author, email, time, ...subject] = fields

    if (!hash || !/^[0-9a-f]{40,64}$/.test(hash)) {
      continue
    }

    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '',
      email: email ?? '',
      time: Number(time) || 0,
      subject: subject.join(FIELD),
    })
  }

  return commits
}

/** `for-each-ref` with the fields of `refs()`, one ref per line. */
export function parseRefs(stdout: string): Ref[] {
  const out: Ref[] = []

  for (const line of stdout.split('\n')) {
    const [full, object, peeled, upstream, track, symref] = line.split(FIELD)

    if (!full || !object || symref) {
      continue
    }

    const target = peeled || object

    if (full.startsWith('refs/heads/')) {
      const name = full.slice('refs/heads/'.length)
      const ref: Ref = { kind: 'branch', name, target }

      if (upstream) {
        ref.upstream = upstream
        ref.isUpstreamGone = track === 'gone'
        ref.track = parseTrack(track ?? '')
      }

      out.push(ref)
    } else if (full.startsWith('refs/remotes/')) {
      const name = full.slice('refs/remotes/'.length)

      if (!name.endsWith('/HEAD')) {
        out.push({ kind: 'remote', name, target })
      }
    } else if (full.startsWith('refs/tags/')) {
      out.push({ kind: 'tag', name: full.slice('refs/tags/'.length), target })
    }
  }

  return out
}

function parseTrack(track: string): readonly [number, number] {
  const ahead = /ahead (\d+)/.exec(track)?.[1]
  const behind = /behind (\d+)/.exec(track)?.[1]

  return [Number(ahead ?? 0), Number(behind ?? 0)]
}

/** `status --porcelain=v1 -z`: `XY path\0`, a rename followed by its source. */
export function parseStatus(stdout: string): StatusEntry[] {
  const parts = stdout.split('\0')
  const out: StatusEntry[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? ''

    if (part.length < 4) {
      continue
    }

    const x = part[0] ?? ' '
    const y = part[1] ?? ' '
    const path = part.slice(3)
    const isMove = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    const entry: StatusEntry = { path, code: statusCode(x, y) }

    if (isMove) {
      entry.oldPath = parts[i + 1]
      i += 1
    }

    out.push(entry)
  }

  return out
}

function statusCode(x: string, y: string): string {
  const pair = x + y

  if (pair === '??') return '?'
  if (x === 'U' || y === 'U' || pair === 'AA' || pair === 'DD') return 'U'
  if (x === 'R' || y === 'R') return 'R'
  if (x === 'C' || y === 'C') return 'C'
  if (x === 'A') return 'A'
  if (x === 'D' || y === 'D') return 'D'
  if (x === 'T' || y === 'T') return 'T'

  return 'M'
}

/** `worktree list --porcelain`: blocks of `key value` lines. */
export function parseWorktrees(stdout: string): Worktree[] {
  const out: Worktree[] = []
  let current: Worktree | null = null

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null }
      out.push(current)
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length)
    }
  }

  return out
}

/**
 * `diff-tree`/`diff --numstat -z`: `a\td\tpath\0`, or for a rename
 * `a\td\t\0old\0new\0`. Binary files count `-`, read as null.
 */
export function parseNumstat(stdout: string): FileChange[] {
  const parts = stdout.split('\0')
  const out: FileChange[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const part = (parts[i] ?? '').replace(/^\n+/, '')
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(part)

    if (!match) {
      continue
    }

    const added = match[1] === '-' ? null : Number(match[1])
    const deleted = match[2] === '-' ? null : Number(match[2])

    if (match[3] === '') {
      const oldPath = parts[i + 1] ?? ''
      const path = parts[i + 2] ?? ''

      out.push({ status: 'R', path, oldPath, added, deleted })
      i += 2
    } else {
      out.push({ status: 'M', path: match[3] ?? '', added, deleted })
    }
  }

  return out
}

/** `diff-tree --name-status -z`: `S\0path\0`, or `R100\0old\0new\0`. */
export function parseNameStatus(
  stdout: string,
): { status: string; path: string; oldPath?: string }[] {
  const parts = stdout.split('\0').map(part => part.replace(/^\n+/, ''))
  const out: { status: string; path: string; oldPath?: string }[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i] ?? ''
    const letter = code[0]

    if (!letter || !/^[ACDMRTUX]\d*$/.test(code)) {
      continue
    }

    if (letter === 'R' || letter === 'C') {
      out.push({ status: letter, oldPath: parts[i + 1] ?? '', path: parts[i + 2] ?? '' })
      i += 2
    } else {
      out.push({ status: letter, path: parts[i + 1] ?? '' })
      i += 1
    }
  }

  return out
}

/** Joins `--name-status` and `--numstat` of one diff into file changes. */
export function joinChanges(
  statuses: readonly { status: string; path: string; oldPath?: string }[],
  counts: readonly FileChange[],
): FileChange[] {
  const byPath = new Map(counts.map(count => [count.path, count]))

  return statuses.map(entry => {
    const count = byPath.get(entry.path)
    const change: FileChange = {
      status: entry.status,
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

/**
 * The hunks of a unified diff, from its first `@@`: what a diff view draws.
 * `binary` when git only says the files differ.
 */
export function hunksOf(diff: string): { kind: 'hunks'; source: string } | { kind: 'binary' } | { kind: 'empty' } {
  const start = diff.search(/^@@ /m)

  if (start === -1) {
    return /^Binary files /m.test(diff) ? { kind: 'binary' } : { kind: 'empty' }
  }

  return { kind: 'hunks', source: diff.slice(start).replace(/\n$/, '') }
}

function basename(path: string): string {
  const parts = stripSlash(path).split('/')

  return parts[parts.length - 1] || path
}

function stripSlash(path: string): string {
  return path.replace(/\/+$/, '')
}
