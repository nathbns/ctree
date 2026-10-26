// The git command lines the mod runs, and the guard that keeps them read-only.
// Each builder returns the arguments after `git`; the runner adds READ_FLAGS.

/** A record separator git never writes inside the fields we ask for. */
export const FIELD = '\x1f'

/**
 * Prepended to every run: no optional index lock, no fsmonitor hook, no gpg
 * call from `log`, no colour, paths unquoted.
 */
export const READ_FLAGS: readonly string[] = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=false',
]

/** Environment for the child: English messages, never a credential prompt. */
export const GIT_ENV: Readonly<Record<string, string>> = {
  LC_ALL: 'C',
  LANGUAGE: '',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}

/** The empty tree, the parent a root commit is diffed against (SHA-1). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export const PAGE_SIZE = 100

export const repoInfo = (): string[] => [
  'rev-parse', '--path-format=absolute',
  '--show-toplevel', '--git-dir', '--git-common-dir',
]

export const headRef = (): string[] => ['symbolic-ref', '-q', 'HEAD']

export const headCommit = (): string[] => [
  'rev-parse', '-q', '--verify', 'HEAD^{commit}',
]

export const userEmail = (): string[] => ['config', '--get', 'user.email']

export const refs = (): string[] => [
  'for-each-ref',
  `--format=${[
    '%(refname)', '%(objectname)', '%(*objectname)',
    '%(upstream:short)', '%(upstream:track,nobracket)', '%(symref)',
  ].join('%1f')}`,
  'refs/heads', 'refs/remotes', 'refs/tags',
]

export const status = (): string[] => [
  'status', '--porcelain=v1', '-z', '--untracked-files=all',
]

export const worktrees = (): string[] => ['worktree', 'list', '--porcelain']

/**
 * One page of history, newest first, topologically ordered so a parent never
 * comes before its children. One commit more than asked tells if more exist.
 */
export const log = (options: {
  skip: number
  count: number
  withHead: boolean
}): string[] => [
  'log', '--topo-order', '-z', '--no-color', '--no-decorate',
  `--format=${['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f')}`,
  `--skip=${options.skip}`, `-n${options.count + 1}`,
  ...(options.withHead ? ['HEAD'] : []),
  '--branches', '--remotes', '--tags', '--',
]

/**
 * Commits reachable from HEAD or a local branch that were not reachable at
 * the session's start, committed by the person's own identity. The tips the
 * session started from go on stdin (`^<hash>` lines).
 */
export const sessionCommits = (options: {
  withHead: boolean
  email?: string
}): string[] => [
  'rev-list', '--max-count=1000',
  ...(options.email ? [`--committer=<${escapeRegex(options.email)}>`] : []),
  ...(options.withHead ? ['HEAD'] : []),
  '--branches', '--stdin',
]

/** What a commit changes against its first parent: counts, then statuses. */
export const commitNumstat = (hash: string, parent: string | undefined): string[] =>
  parent === undefined
    ? ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--root', '--numstat', hash]
    : ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--numstat', parent, hash]

export const commitNameStatus = (hash: string, parent: string | undefined): string[] =>
  parent === undefined
    ? ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--root', '--name-status', hash]
    : ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--name-status', parent, hash]

/** Line counts of the working tree (index and files) against HEAD. */
export const worktreeNumstat = (hasHead: boolean): string[] =>
  hasHead
    ? ['diff', '-z', '-M', '--numstat', '--no-ext-diff', '--no-textconv', 'HEAD', '--']
    : ['diff', '-z', '-M', '--numstat', '--no-ext-diff', '--no-textconv', '--cached', '--']

/** Lines of a file git does not track yet. Exits 1 when it has any. */
export const untrackedNumstat = (path: string): string[] => [
  'diff', '-z', '--numstat', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path,
]

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']

/** One file of a commit, against its first parent (or the empty tree). */
export const commitFileDiff = (
  hash: string,
  parent: string | undefined,
  path: string,
  oldPath?: string,
): string[] => [
  'diff', ...DIFF_FLAGS, parent ?? EMPTY_TREE, hash, '--', ...(oldPath ? [oldPath] : []), path,
]

/** One tracked file of the working tree against HEAD. */
export const worktreeFileDiff = (path: string, oldPath?: string): string[] => [
  'diff', ...DIFF_FLAGS, 'HEAD', '--', ...(oldPath ? [oldPath] : []), path,
]

/** A file git does not track yet, shown whole as added. Exits 1 on a diff. */
export const untrackedFileDiff = (path: string): string[] => [
  'diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path,
]

/** The subcommands the mod may run, each with what makes it a read. */
const READS: Record<string, (rest: readonly string[]) => boolean> = {
  'rev-parse': () => true,
  'rev-list': () => true,
  'log': () => true,
  'for-each-ref': () => true,
  'status': rest => rest.includes('--porcelain=v1'),
  'diff': () => true,
  'diff-tree': () => true,
  'show': () => true,
  'worktree': rest => rest[0] === 'list',
  'config': rest => rest[0] === '--get' && rest.length === 2,
  'symbolic-ref': rest => rest.length === 2 && rest[0] === '-q' && rest[1] === 'HEAD',
}

/**
 * Whether `args` (after `git` and READ_FLAGS) only reads the repository.
 * Anything unlisted, or a listed command in a form that writes, is refused.
 */
export function isReadOnly(args: readonly string[]): boolean {
  const [command, ...rest] = args
  const check = command === undefined ? undefined : READS[command]
  const forbidden = rest.some(arg =>
    /^--(output|ext-diff|textconv|exec|upload-pack|receive-pack)\b/.test(arg),
  )

  return check !== undefined && !forbidden && check(rest)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
