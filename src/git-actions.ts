// The changes the pane can make (switch branch, create a tag, push, apply a
// stash), each built as the exact git command it runs and the words its
// confirmation shows, and the guard that admits those shapes and no other write.

import * as Cmd from './git-commands'
import { FIELD } from './git-commands'
import { parseLog } from './git-parse'
import { messages, NOTES, t } from './i18n'
import type { Commit, GitRunner, RepoSnapshot, Stash } from './types'

/** A change ready to confirm: what runs, and what the pane and Claude are told. */
export type Action = {
  kind: 'switch' | 'tag' | 'push' | 'undo' | 'stash'
  /** The arguments after `git`. */
  args: string[]
  /** Further commands run in order once `args` succeeded; the first failure stops them. */
  then?: string[][]
  title: string
  details: string[]
  /** The word on the confirm key. */
  confirm: string
  /** Shown once it ran. */
  success: string
  /** Appended to the conversation for Claude once it ran. */
  note: string
  /** The journal entry it undoes. */
  undoes?: string
}

export type SwitchTarget =
  | { kind: 'branch'; branch: string }
  /** A remote branch with no local one: create it, tracking the remote. */
  | { kind: 'track'; remote: string }
  | { kind: 'detach'; hash: string }

const HEX = /^[0-9a-f]{40,64}$/

/** Where `c` on a commit can go: its branches, else the commit itself, detached. */
export function switchTargets(snapshot: RepoSnapshot, hash: string): SwitchTarget[] {
  const current = snapshot.head.kind === 'branch' ? snapshot.head.branch : null
  const locals = snapshot.refs.filter(ref => ref.kind === 'branch')
  const names = new Set(locals.map(ref => ref.name))
  const here: SwitchTarget[] = [
    ...locals
      .filter(ref => ref.target === hash && ref.name !== current)
      .map(ref => ({ kind: 'branch' as const, branch: ref.name })),
    ...snapshot.refs
      .filter(ref => ref.kind === 'remote' && ref.target === hash && !names.has(branchOf(ref.name)))
      .map(ref => ({ kind: 'track' as const, remote: ref.name })),
  ]

  if (here.length > 0 || snapshot.head.hash === hash) {
    return here
  }

  return [{ kind: 'detach', hash }]
}

export function switchAction(snapshot: RepoSnapshot, target: SwitchTarget): Action {
  const m = t().action
  const dirty = snapshot.status.length
  const kept = dirty > 0 ? [m.kept(dirty)] : []

  switch (target.kind) {
    case 'branch':
      return {
        kind: 'switch',
        args: ['switch', target.branch],
        title: m.switchTitle(target.branch),
        details: kept,
        confirm: m.switchConfirm,
        success: m.switched(target.branch),
        note: NOTES.switched(target.branch),
      }
    case 'track': {
      const branch = branchOf(target.remote)

      return {
        kind: 'switch',
        args: ['switch', '--track', target.remote],
        title: m.trackTitle(branch, target.remote),
        details: [m.trackDetail(branch, target.remote), ...kept],
        confirm: m.trackConfirm,
        success: m.tracked(branch, target.remote),
        note: NOTES.tracked(branch, target.remote),
      }
    }
    case 'detach': {
      const short = target.hash.slice(0, 7)

      return {
        kind: 'switch',
        args: ['switch', '--detach', target.hash],
        title: m.detachTitle(short),
        details: [m.detachDetail, ...kept],
        confirm: m.detachConfirm,
        success: m.detached(short),
        note: NOTES.detached(short),
      }
    }
  }
}

/** A stash's changes put back in the working tree, the stash kept (`apply`, never `pop`). */
export function applyStashAction(stash: Stash, dirty: number): Action {
  const m = t().action

  return {
    kind: 'stash',
    args: ['stash', 'apply', stash.hash],
    title: m.stashTitle(stash.selector, stash.subject),
    details: [m.stashDetail, ...(dirty > 0 ? [m.stashDirty(dirty)] : [])],
    confirm: m.stashConfirm,
    success: m.stashed(stash.selector),
    note: NOTES.stashApplied(stash.selector, stash.subject, stash.hash.slice(0, 7)),
  }
}

/** Why `name` cannot be a new tag, or null when it can. */
export function tagNameError(name: string, existing: readonly string[]): string | null {
  const m = t().action

  if (name.trim() === '') return m.tagNoName
  if (existing.includes(name)) return m.tagTaken(name)
  if (!isSafeRefName(name)) return m.tagBadName

  return null
}

/** The version after the highest `v1.2.3`-like tag (`v1.3.0`), or '' when none. */
export function nextVersion(tags: readonly string[]): string {
  let best: { prefix: string; parts: [number, number, number] } | null = null

  for (const tag of tags) {
    const match = /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(tag)

    if (!match) continue

    const parts: [number, number, number] = [Number(match[2]), Number(match[3]), Number(match[4])]
    const isHigher = !best || parts[0] > best.parts[0] || (parts[0] === best.parts[0] && (parts[1] > best.parts[1] || (parts[1] === best.parts[1] && parts[2] > best.parts[2])))

    if (isHigher) best = { prefix: match[1] ?? '', parts }
  }

  return best ? `${best.prefix}${best.parts[0]}.${best.parts[1] + 1}.0` : ''
}

/** An annotated tag, so that the next push takes it along (`--follow-tags`). */
export function tagAction(commit: Commit, name: string, message: string): Action {
  const m = t().action
  const short = commit.hash.slice(0, 7)
  const text = message.trim() || name

  return {
    kind: 'tag',
    args: ['tag', '-a', name, '-m', text, commit.hash],
    title: m.tagTitle(name, short),
    details: [m.tagSubject(commit.subject), m.tagDetail],
    confirm: m.tagConfirm,
    success: m.tagged(name, short),
    note: NOTES.tagged(name, short, commit.subject),
  }
}

export type PushPlan =
  | { kind: 'ready'; action: Action }
  | { kind: 'blocked'; title: string; reason: string }

/**
 * What pushing the current branch would send: its commits, and the annotated
 * tags reachable from it that the remote lacks. Never a forced push: a
 * branch behind its upstream is blocked.
 *
 * @param env the ssh environment for the remote's tags (network)
 */
export async function planPush(
  git: GitRunner,
  snapshot: RepoSnapshot,
  env: Readonly<Record<string, string>> = {},
): Promise<PushPlan> {
  const m = t().push
  const head = snapshot.head
  const at = { cwd: snapshot.repo.toplevel }
  const blocked = (reason: string, title = m.cannot): PushPlan => ({ kind: 'blocked', title, reason })

  if (head.kind === 'detached') return blocked(m.detached)
  if (head.hash === null) return blocked(m.noCommit)

  const branch = snapshot.refs.find(ref => ref.kind === 'branch' && ref.name === head.branch)
  const listed = await git(Cmd.remotes(), at)
  const remotes = listed.code === 0 ? listed.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []

  if (remotes.length === 0) return blocked(m.noRemote)

  const upstream = branch?.upstream && !branch.isUpstreamGone ? branch.upstream : null
  const remote = upstream
    ? remotes.filter(name => upstream.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0]
    : remotes.includes('origin') ? 'origin' : remotes[0]

  if (!remote) return blocked(m.notRemote(head.branch, upstream ?? ''))

  const behind = branch?.track?.[1] ?? 0

  if (upstream && behind > 0) {
    return blocked(m.behind(upstream, behind))
  }

  const remoteBranch = upstream ? upstream.slice(remote.length + 1) : head.branch
  const [commits, merged, remoteTags] = await Promise.all([
    git(Cmd.rangeLog(upstream ? [`${upstream}..HEAD`] : ['HEAD', '--not', '--remotes']), at),
    git(Cmd.mergedTags(), at),
    git(Cmd.remoteTags(remote), { ...at, env, timeoutMs: 20_000 }),
  ])

  if (remoteTags.code !== 0) {
    return blocked(m.unreachable(remote, firstLine(remoteTags.stderr) || m.lsRemoteFailed))
  }

  const there = new Set(
    remoteTags.stdout.split('\n').map(line => line.split('\t')[1]?.replace(/^refs\/tags\//, '')).filter(Boolean),
  )
  const tags = merged.stdout
    .split('\n')
    .map(line => line.split(FIELD))
    .filter(([name, type]) => name && type === 'tag' && !there.has(name))
    .map(([name]) => name ?? '')
  const outgoing = parseLog(commits.stdout)

  if (upstream && outgoing.length === 0 && tags.length === 0) {
    return blocked(m.upToDate(upstream), m.upToDateTitle)
  }

  const refspec = remoteBranch === head.branch ? head.branch : `${head.branch}:refs/heads/${remoteBranch}`
  const shown = outgoing.slice(0, 3).map(commit => `${commit.hash.slice(0, 7)} ${commit.subject}`)

  return {
    kind: 'ready',
    action: {
      kind: 'push',
      args: ['push', '--follow-tags', ...(upstream ? [] : ['-u']), remote, refspec],
      title: m.title(head.branch, remote, remoteBranch),
      details: [
        ...(upstream ? [] : [m.creates(remote, remoteBranch)]),
        m.commits(m.count(outgoing.length), shown),
        ...(tags.length ? [m.tags(tags)] : []),
      ],
      confirm: m.confirm,
      success: m.pushed(head.branch, remote, remoteBranch),
      note: NOTES.pushed(head.branch, remote, remoteBranch, messages('en').push.count(outgoing.length), tags),
    },
  }
}

const ZERO = '0'.repeat(40)
const isLocalRef = (ref: string) => /^refs\/(heads|tags)\//.test(ref) && isSafeRefName(ref)

/**
 * Whether `args` (after `git`) is one of the writes this module and the
 * journal build: `switch <branch>`, `switch --track <remote>/<branch>`,
 * `switch --detach <hash>`, `tag -a <name> -m <message> <hash>`, `push
 * --follow-tags [-u] <remote> <branch>[:refs/heads/<branch>]`; to undo,
 * `update-ref <local ref> <hash> <hash|zero>`, `update-ref -d <local ref>
 * <hash>`, `reset --keep|--soft <hash>`, `stash apply <hash>`; to save
 * changes before a command throws them away, `stash create`. Nothing forced,
 * no remote ref touched, every change checked against where the ref stands.
 */
export function isAllowedWrite(args: readonly string[]): boolean {
  const [command, ...rest] = args
  const [a = '', b = '', c = '', d = '', e = ''] = rest

  switch (command) {
    case 'update-ref':
      return (
        (rest.length === 3 && isLocalRef(a) && HEX.test(b) && b !== ZERO && (HEX.test(c) || c === ZERO)) ||
        (rest.length === 3 && a === '-d' && isLocalRef(b) && HEX.test(c))
      )
    case 'reset':
      return rest.length === 2 && (a === '--keep' || a === '--soft') && HEX.test(b)
    case 'stash':
      return (rest.length === 1 && a === 'create') || (rest.length === 2 && a === 'apply' && HEX.test(b))
    case 'switch':
      return (
        (rest.length === 1 && isSafeRefName(a)) ||
        (rest.length === 2 && a === '--track' && isSafeRefName(b) && b.includes('/')) ||
        (rest.length === 2 && a === '--detach' && HEX.test(b))
      )
    case 'tag':
      return rest.length === 5 && a === '-a' && isSafeRefName(b) && c === '-m' && d.trim() !== '' && HEX.test(e)
    case 'push': {
      if (a !== '--follow-tags') return false

      const tail = rest.slice(1)
      const [remote = '', refspec = '', ...extra] = b === '-u' ? tail.slice(1) : tail
      const [source = '', target, ...more] = refspec.split(':')

      return (
        extra.length === 0 &&
        more.length === 0 &&
        isSafeRefName(remote) &&
        isSafeRefName(source) &&
        !source.startsWith('+') &&
        (target === undefined || (target.startsWith('refs/heads/') && isSafeRefName(target)))
      )
    }
    default:
      return false
  }
}

/** A name git accepts for a branch or tag (`git check-ref-format`), never an option. */
export function isSafeRefName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('//') &&
    name !== '@' &&
    !/(^|\/)\./.test(name)
  )
}

/** The command as the confirmation shows it: `git switch main`, hashes short. */
export function displayCommand(args: readonly string[]): string {
  const shown = args.map(arg => {
    if (HEX.test(arg)) return arg.slice(0, 7)

    return /^[\w./:@=+-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`
  })

  return `git ${shown.join(' ')}`
}

function branchOf(remoteRef: string): string {
  return remoteRef.slice(remoteRef.indexOf('/') + 1)
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/^fatal: /, '') ?? ''
}
