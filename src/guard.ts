// The guard: finds, in a shell command Claude is about to run, the git
// commands that lose something hard to get back (uncommitted changes,
// untracked files, stashes, commits only one branch holds, a remote's
// history), and works out what exactly, before the command runs.

import * as Cmd from './git-commands'
import { FIELD } from './git-commands'
import { parseLog, parseStatus } from './git-parse'
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
  | { kind: 'other'; what: string }

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
      return { kind: 'other', what: 'réécrit tout l’historique' }
    case 'reflog':
      return positional(args)[0] === 'expire' || positional(args)[0] === 'delete' ? { kind: 'other', what: 'efface le reflog, le filet de secours de git' } : null
    case 'gc':
      return args.some(arg => /^--prune(=now|=all)?$/.test(arg)) ? { kind: 'other', what: 'supprime pour de bon les commits que plus rien ne référence' } : null
    case 'update-ref':
      return set.has('-d') ? { kind: 'other', what: `supprime la référence ${positional(args)[0] ?? ''}`.trim() } : null
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

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`

/** The commits only `revs` reach, as `n commits (abc1234 subject, …)`. */
async function commitsOnly(git: GitRunner, toplevel: string, revs: readonly string[]): Promise<string | null> {
  const result = await git(Cmd.rangeLog(revs), { cwd: toplevel })

  if (result.code !== 0) return null

  const commits = parseLog(result.stdout)

  if (commits.length === 0) return null

  const count = commits.length > 50 ? 'plus de 50 commits' : plural(commits.length, 'commit', 'commits')
  const named = commits.slice(0, 2).map(commit => `${commit.hash.slice(0, 7)} ${commit.subject}`)

  return `${count} (${named.join(' · ')}${commits.length > 2 ? ' · …' : ''})`
}

/** The tracked changes a command would throw away, under `paths` when given. */
function changedFiles(status: readonly StatusEntry[], paths: readonly string[]): StatusEntry[] {
  const tracked = status.filter(entry => entry.code !== '?')
  const scope = paths.filter(path => path !== '.' && path !== ':/')

  return scope.length === 0 ? tracked : tracked.filter(entry => scope.some(path => entry.path === path || entry.path.startsWith(`${path.replace(/\/$/, '')}/`)))
}

const fileList = (files: readonly { path: string }[]) =>
  `${files.slice(0, 3).map(file => file.path).join(', ')}${files.length > 3 ? ', …' : ''}`

/**
 * What a risk would lose, in plain words, one line each: read from git
 * before the command runs. Empty when it would lose nothing after all.
 */
export async function consequences(git: GitRunner, risk: Risk, context: Context): Promise<string[]> {
  const at = { cwd: context.toplevel }
  const others = (except: string | null, kind: 'branches' | 'remotes') =>
    except ? [`--exclude=${except}`, `--${kind}`] : [`--${kind}`]

  switch (risk.kind) {
    case 'reset-hard': {
      const target = await git(Cmd.resolveCommit(risk.target), at)
      const lines: string[] = []

      if (target.code === 0) {
        const lost = await commitsOnly(git, context.toplevel, ['HEAD', '--not', target.stdout.trim(), ...others(context.branch, 'branches'), '--remotes', '--tags'])

        if (lost) lines.push(`${lost} ne seront plus sur aucune branche`)
      }

      const files = changedFiles(context.status, [])

      if (files.length) lines.push(`${plural(files.length, 'fichier modifié perdu', 'fichiers modifiés perdus')} : ${fileList(files)}`)

      return lines
    }
    case 'discard': {
      const files = changedFiles(context.status, risk.paths)

      return files.length ? [`${plural(files.length, 'fichier modifié perdu', 'fichiers modifiés perdus')} : ${fileList(files)}`] : []
    }
    case 'clean': {
      const dry = await git(Cmd.cleanDryRun({ dirs: risk.dirs, ignored: risk.ignored }, risk.paths), at)
      const doomed = dry.stdout.split('\n').map(line => line.replace(/^Would remove /, '').trim()).filter(Boolean)

      return doomed.length ? [`${plural(doomed.length, 'fichier non suivi supprimé', 'fichiers non suivis supprimés')}, sans copie possible : ${fileList(doomed.map(path => ({ path })))}`] : []
    }
    case 'stash-drop':
    case 'stash-clear': {
      const list = await git(Cmd.stashList(), at)
      const entries = list.stdout.split('\n').filter(Boolean).map(line => line.split(FIELD))
      const lost = risk.kind === 'stash-clear' ? entries : entries.filter(([name]) => name === risk.which || `stash@{${risk.which}}` === name)

      return lost.length ? [`${plural(lost.length, 'stash perdu', 'stashs perdus')} : ${lost.slice(0, 2).map(([name, text]) => `${name} ${text ?? ''}`.trim()).join(' · ')}`] : []
    }
    case 'force-push': {
      const remote = risk.remote ?? 'origin'
      const specs = risk.refspecs.length ? risk.refspecs : context.branch ? [context.branch] : []
      const lines: string[] = []

      for (const spec of specs.slice(0, 3)) {
        const [source = '', target = source] = spec.split(':')
        const branch = target.replace(/^refs\/heads\//, '')
        const lost = await commitsOnly(git, context.toplevel, [`refs/remotes/${remote}/${branch}`, '--not', source || 'HEAD'])

        if (lost) lines.push(`${remote}/${branch} perd ${lost}`)
      }

      return lines.length ? lines : [`réécrit ${specs.map(spec => `${remote}/${spec.split(':').pop()}`).join(', ') || 'la branche distante'} (état distant non vérifié)`]
    }
    case 'push-delete': {
      const remote = risk.remote ?? 'origin'
      const lines: string[] = []

      for (const branch of risk.branches.slice(0, 3)) {
        const lost = await commitsOnly(git, context.toplevel, [`refs/remotes/${remote}/${branch}`, '--not', ...others(`${remote}/${branch}`, 'remotes'), '--branches', '--tags'])

        lines.push(`supprime ${remote}/${branch}${lost ? ` : ${lost} n’existent que là` : ''}`)
      }

      return lines
    }
    case 'branch-delete': {
      const lines: string[] = []

      for (const branch of risk.branches.slice(0, 3)) {
        const lost = await commitsOnly(git, context.toplevel, [`refs/heads/${branch}`, '--not', ...others(branch, 'branches'), '--remotes', '--tags'])

        if (lost) lines.push(`${branch} : ${lost} n’existent que sur elle`)
      }

      return lines
    }
    case 'other':
      return [risk.what]
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
