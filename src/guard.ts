// The guard: finds, in a shell command Claude is about to run, the git
// commands that lose something hard to get back (uncommitted changes,
// untracked files, stashes, commits only one branch holds, a remote's
// history), and works out what exactly, before the command runs.

import * as Cmd from './git-commands'
import { FIELD } from './git-commands'
import { parseLog, parseStatus } from './git-parse'
import { type CommitsShown, type Messages, t } from './i18n'
import type { GitRunner, StatusEntry } from './types'

/** One `git …` found in a shell command: its subcommand and arguments. */
export type GitCall = {
  subcommand: string
  args: string[]
  /** Run with `-C <dir>` or `--git-dir`/`--work-tree`: about another repository. */
  isElsewhere: boolean
  /** The git command as written, for messages. */
  text: string
}

/** Global options of `git` that take a value in the next word. */
const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** Splits a shell command into words per simple command: quotes kept together, operators split. */
export function shellCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? ''

    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
    } else if (char === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
    } else if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '(' || char === ')') {
      endCommand()
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else {
      word += char
      hasWord = true
    }
  }

  endCommand()

  return commands
}

/** Every git command in a shell command, past env assignments and git's own options. */
export function gitCalls(command: string): GitCall[] {
  const calls: GitCall[] = []

  for (const words of shellCommands(command)) {
    let i = 0

    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i += 1
    while (words[i] === 'sudo' || words[i] === 'command' || words[i] === 'env') i += 1

    if (!/(^|\/)git$/.test(words[i] ?? '')) continue

    const start = i
    let isElsewhere = false

    i += 1

    while (i < words.length && (words[i] ?? '').startsWith('-')) {
      const option = words[i] ?? ''
      const name = option.split('=')[0] ?? option

      if (name === '-C' || name === '--git-dir' || name === '--work-tree') isElsewhere = true
      i += VALUED.has(option) ? 2 : 1
    }

    const subcommand = words[i]

    if (subcommand) {
      calls.push({ subcommand, args: words.slice(i + 1), isElsewhere, text: words.slice(start).join(' ') })
    }
  }

  return calls
}

export type Risk =
  /** Moves the branch and throws the uncommitted changes of tracked files away. */
  | { kind: 'reset-hard'; target: string }
  /** Throws away uncommitted changes of tracked files (all, or under `paths`). */
  | { kind: 'discard'; paths: string[] }
  /** Deletes untracked files: nothing keeps a copy. */
  | { kind: 'clean'; dirs: boolean; ignored: 'no' | 'also' | 'only'; paths: string[] }
  | { kind: 'stash-drop'; which: string }
  | { kind: 'stash-clear' }
  /** Overwrites a remote branch. */
  | { kind: 'force-push'; remote: string | null; refspecs: string[] }
  | { kind: 'push-delete'; remote: string | null; branches: string[] }
  | { kind: 'branch-delete'; branches: string[] }
  /** Rewrites or prunes history in ways hard to come back from. */
  | { kind: 'other'; what: 'rewrite' | 'reflog' | 'prune' | 'delete-ref'; ref?: string }

const isOption = (word: string) => word.startsWith('-')

/** Short flags in a cluster (`-fdx`), and long ones as written. */
const flags = (args: readonly string[]) => {
  const set = new Set<string>()

  for (const arg of args) {
    if (arg === '--') break
    if (arg.startsWith('--')) set.add(arg.split('=')[0] ?? arg)
    else if (arg.startsWith('-')) for (const letter of arg.slice(1)) set.add(`-${letter}`)
  }

  return set
}

const afterDashes = (args: readonly string[]) => {
  const at = args.indexOf('--')

  return at === -1 ? [] : args.slice(at + 1)
}

const positional = (args: readonly string[]) => {
  const at = args.indexOf('--')

  return (at === -1 ? args : args.slice(0, at)).filter(arg => !isOption(arg))
}

/** What a git command would lose, or null when it loses nothing the journal cannot give back. */
export function riskOf(call: GitCall): Risk | null {
  const { subcommand, args } = call
  const set = flags(args)

  switch (subcommand) {
    case 'reset':
      return set.has('--hard') ? { kind: 'reset-hard', target: positional(args)[0] ?? 'HEAD' } : null
    case 'checkout': {
      const paths = afterDashes(args)

      if (paths.length > 0) return { kind: 'discard', paths }
      if (set.has('-f') || set.has('--force')) return { kind: 'discard', paths: [] }

      const words = positional(args)

      return words.length === 1 && words[0] === '.' ? { kind: 'discard', paths: ['.'] } : null
    }
    case 'restore': {
      const isWorktree = !(set.has('--staged') || set.has('-S')) || set.has('--worktree') || set.has('-W')

      return isWorktree ? { kind: 'discard', paths: [...positional(args), ...afterDashes(args)] } : null
    }
    case 'switch':
      return set.has('-f') || set.has('--force') || set.has('--discard-changes') ? { kind: 'discard', paths: [] } : null
    case 'clean': {
      const isForced = set.has('-f') || set.has('--force')
      const isDry = set.has('-n') || set.has('--dry-run')

      return isForced && !isDry
        ? { kind: 'clean', dirs: set.has('-d'), ignored: set.has('-x') ? 'also' : set.has('-X') ? 'only' : 'no', paths: [...afterDashes(args), ...positional(args)] }
        : null
    }
    case 'stash': {
      const [action, which] = positional(args)

      if (action === 'drop') return { kind: 'stash-drop', which: which ?? 'stash@{0}' }
      if (action === 'clear') return { kind: 'stash-clear' }

      return null
    }
    case 'push': {
      const [remote = null, ...refspecs] = positional(args)
      const isForced =
        set.has('-f') || set.has('--force') || set.has('--force-with-lease') || set.has('--force-if-includes') || set.has('--mirror') || refspecs.some(spec => spec.startsWith('+'))
      const deleted = set.has('-d') || set.has('--delete') ? refspecs : refspecs.filter(spec => spec.startsWith(':')).map(spec => spec.slice(1))

      if (deleted.length > 0) return { kind: 'push-delete', remote, branches: deleted }
      if (isForced) return { kind: 'force-push', remote, refspecs: refspecs.map(spec => spec.replace(/^\+/, '')) }

      return null
    }
    case 'branch': {
      const isDelete = set.has('-D') || ((set.has('-d') || set.has('--delete')) && (set.has('-f') || set.has('--force')))

      return isDelete ? { kind: 'branch-delete', branches: positional(args) } : null
    }
    case 'filter-branch':
    case 'filter-repo':
      return { kind: 'other', what: 'rewrite' }
    case 'reflog':
      return positional(args)[0] === 'expire' || positional(args)[0] === 'delete' ? { kind: 'other', what: 'reflog' } : null
    case 'gc':
      return args.some(arg => /^--prune(=now|=all)?$/.test(arg)) ? { kind: 'other', what: 'prune' } : null
    case 'update-ref':
      return set.has('-d') ? { kind: 'other', what: 'delete-ref', ref: positional(args)[0] ?? '' } : null
    default:
      return null
  }
}

/** Whether the command throws tracked changes away, so they are saved first. */
export function losesChanges(risk: Risk): boolean {
  return risk.kind === 'reset-hard' || risk.kind === 'discard'
}

/** What the guard learnt about the repository, to word what a risk loses. */
export type Context = {
  toplevel: string
  status: readonly StatusEntry[]
  branch: string | null
}

/**
 * One thing a risky command would lose, read from git before it runs; worded
 * by `lossText` in either language (the question in the person's, the
 * refusal Claude reads in English).
 */
export type Loss =
  /** Commits no branch, remote branch or tag will hold once the branch moves. */
  | { kind: 'orphaned'; commits: CommitsShown }
  /** Tracked files whose uncommitted changes go. */
  | { kind: 'changes'; files: readonly string[] }
  | { kind: 'untracked'; files: readonly string[] }
  /** `stash@{1} WIP on main: …` each. */
  | { kind: 'stashes'; stashes: readonly string[] }
  | { kind: 'remote-loses'; remote: string; branch: string; commits: CommitsShown }
  /** A forced push whose remote side could not be read. */
  | { kind: 'remote-rewritten'; targets: readonly string[] }
  | { kind: 'remote-deleted'; remote: string; branch: string; commits: CommitsShown | null }
  | { kind: 'branch-only'; branch: string; commits: CommitsShown }
  | { kind: 'other'; what: 'rewrite' | 'reflog' | 'prune' | 'delete-ref'; ref?: string }
  /** Run in another repository (`git -C`): not read. */
  | { kind: 'elsewhere'; command: string }
  /** git failed while reading what it loses. */
  | { kind: 'unchecked'; command: string }

/** The commits only `revs` reach: how many, and the first two by hash and subject. */
async function commitsOnly(git: GitRunner, toplevel: string, revs: readonly string[]): Promise<CommitsShown | null> {
  const result = await git(Cmd.rangeLog(revs), { cwd: toplevel })

  if (result.code !== 0) return null

  const commits = parseLog(result.stdout)

  if (commits.length === 0) return null

  return {
    count: commits.length,
    isCut: commits.length > 50,
    named: commits.slice(0, 2).map(commit => `${commit.hash.slice(0, 7)} ${commit.subject}`),
  }
}

/** The tracked changes a command would throw away, under `paths` when given. */
function changedFiles(status: readonly StatusEntry[], paths: readonly string[]): StatusEntry[] {
  const tracked = status.filter(entry => entry.code !== '?')
  const scope = paths.filter(path => path !== '.' && path !== ':/')

  return scope.length === 0 ? tracked : tracked.filter(entry => scope.some(path => entry.path === path || entry.path.startsWith(`${path.replace(/\/$/, '')}/`)))
}

/**
 * What a risk would lose, read from git before the command runs. Empty when
 * it would lose nothing after all.
 */
export async function consequences(git: GitRunner, risk: Risk, context: Context): Promise<Loss[]> {
  const at = { cwd: context.toplevel }
  const others = (except: string | null, kind: 'branches' | 'remotes') =>
    except ? [`--exclude=${except}`, `--${kind}`] : [`--${kind}`]

  switch (risk.kind) {
    case 'reset-hard': {
      const target = await git(Cmd.resolveCommit(risk.target), at)
      const losses: Loss[] = []

      if (target.code === 0) {
        const lost = await commitsOnly(git, context.toplevel, ['HEAD', '--not', target.stdout.trim(), ...others(context.branch, 'branches'), '--remotes', '--tags'])

        if (lost) losses.push({ kind: 'orphaned', commits: lost })
      }

      const files = changedFiles(context.status, [])

      if (files.length) losses.push({ kind: 'changes', files: files.map(file => file.path) })

      return losses
    }
    case 'discard': {
      const files = changedFiles(context.status, risk.paths)

      return files.length ? [{ kind: 'changes', files: files.map(file => file.path) }] : []
    }
    case 'clean': {
      const dry = await git(Cmd.cleanDryRun({ dirs: risk.dirs, ignored: risk.ignored }, risk.paths), at)
      const doomed = dry.stdout.split('\n').map(line => line.replace(/^Would remove /, '').trim()).filter(Boolean)

      return doomed.length ? [{ kind: 'untracked', files: doomed }] : []
    }
    case 'stash-drop':
    case 'stash-clear': {
      const list = await git(Cmd.stashList(), at)
      const entries = list.stdout.split('\n').filter(Boolean).map(line => line.split(FIELD))
      const lost = risk.kind === 'stash-clear' ? entries : entries.filter(([name]) => name === risk.which || `stash@{${risk.which}}` === name)

      return lost.length ? [{ kind: 'stashes', stashes: lost.map(([name, text]) => `${name} ${text ?? ''}`.trim()) }] : []
    }
    case 'force-push': {
      const remote = risk.remote ?? 'origin'
      const specs = risk.refspecs.length ? risk.refspecs : context.branch ? [context.branch] : []
      const losses: Loss[] = []

      for (const spec of specs.slice(0, 3)) {
        const [source = '', target = source] = spec.split(':')
        const branch = target.replace(/^refs\/heads\//, '')
        const lost = await commitsOnly(git, context.toplevel, [`refs/remotes/${remote}/${branch}`, '--not', source || 'HEAD'])

        if (lost) losses.push({ kind: 'remote-loses', remote, branch, commits: lost })
      }

      return losses.length ? losses : [{ kind: 'remote-rewritten', targets: specs.map(spec => `${remote}/${spec.split(':').pop()}`) }]
    }
    case 'push-delete': {
      const remote = risk.remote ?? 'origin'
      const losses: Loss[] = []

      for (const branch of risk.branches.slice(0, 3)) {
        const lost = await commitsOnly(git, context.toplevel, [`refs/remotes/${remote}/${branch}`, '--not', ...others(`${remote}/${branch}`, 'remotes'), '--branches', '--tags'])

        losses.push({ kind: 'remote-deleted', remote, branch, commits: lost })
      }

      return losses
    }
    case 'branch-delete': {
      const losses: Loss[] = []

      for (const branch of risk.branches.slice(0, 3)) {
        const lost = await commitsOnly(git, context.toplevel, [`refs/heads/${branch}`, '--not', ...others(branch, 'branches'), '--remotes', '--tags'])

        if (lost) losses.push({ kind: 'branch-only', branch, commits: lost })
      }

      return losses
    }
    case 'other':
      return [{ kind: 'other', what: risk.what, ...(risk.ref !== undefined ? { ref: risk.ref } : {}) }]
  }
}

/** A loss in plain words, one line, in the language of `m`. */
export function lossText(loss: Loss, m: Messages = t()): string {
  const said = m.loss

  switch (loss.kind) {
    case 'orphaned':
      return said.orphaned(said.commits(loss.commits))
    case 'changes':
      return said.changes(loss.files)
    case 'untracked':
      return said.untracked(loss.files)
    case 'stashes':
      return said.stashes(loss.stashes)
    case 'remote-loses':
      return said.remoteLoses(loss.remote, loss.branch, said.commits(loss.commits))
    case 'remote-rewritten':
      return said.remoteRewritten(loss.targets)
    case 'remote-deleted':
      return said.remoteDeleted(loss.remote, loss.branch, loss.commits ? said.commits(loss.commits) : null)
    case 'branch-only':
      return said.branchOnly(loss.branch, said.commits(loss.commits))
    case 'other':
      return loss.what === 'rewrite' ? said.rewrite : loss.what === 'reflog' ? said.reflog : loss.what === 'prune' ? said.prune : said.deleteRef(loss.ref ?? '')
    case 'elsewhere':
      return said.elsewhere(loss.command)
    case 'unchecked':
      return said.unchecked(loss.command)
  }
}

/** The status the guard reads before it asks. */
export async function readStatus(git: GitRunner, toplevel: string): Promise<StatusEntry[]> {
  const result = await git(Cmd.status(), { cwd: toplevel })

  return result.code === 0 ? parseStatus(result.stdout) : []
}

/** git commands that record or move history without touching the working files. */
const FILE_SAFE = new Set(['add', 'stage', 'commit', 'branch', 'tag', 'update-ref', 'notes', 'push', 'fetch'])

/** Whether every git command in it leaves the working files alone (staging, committing, branching). */
export function keepsFiles(command: string): boolean {
  const calls = gitCalls(command)

  return calls.length > 0 && calls.every(call => FILE_SAFE.has(call.subcommand))
}
