// The three changes the pane can make (switch branch, create a tag, push),
// each built as the exact git command it runs and the words its confirmation
// shows, and the guard that admits those shapes and no other write.

import * as Cmd from './git-commands'
import { FIELD } from './git-commands'
import { parseLog } from './git-parse'
import type { Commit, GitRunner, RepoSnapshot } from './types'

/** A change ready to confirm: what runs, and what the pane and Claude are told. */
export type Action = {
  kind: 'switch' | 'tag' | 'push'
  /** The arguments after `git`. */
  args: string[]
  title: string
  details: string[]
  /** The word on the confirm key. */
  confirm: string
  /** Shown once it ran. */
  success: string
  /** Appended to the conversation for Claude once it ran. */
  note: string
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
  const dirty = snapshot.status.length
  const kept = dirty > 0 ? [`${plural(dirty, 'modification non commitée', 'modifications non commitées')} : git les garde si possible, sinon il refuse.`] : []

  switch (target.kind) {
    case 'branch':
      return {
        kind: 'switch',
        args: ['switch', target.branch],
        title: `⎇ Passer sur ${target.branch}`,
        details: kept,
        confirm: 'basculer',
        success: `✓ Sur ${target.branch}`,
        note: `[gittree] Via le panneau, la personne est passée sur la branche ${target.branch} (git switch ${target.branch}).`,
      }
    case 'track': {
      const branch = branchOf(target.remote)

      return {
        kind: 'switch',
        args: ['switch', '--track', target.remote],
        title: `⎇ Créer ${branch} depuis ${target.remote} et passer dessus`,
        details: [`nouvelle branche locale ${branch}, qui suit ${target.remote}`, ...kept],
        confirm: 'créer et basculer',
        success: `✓ Sur ${branch} (suit ${target.remote})`,
        note: `[gittree] Via le panneau, la personne a créé la branche ${branch} depuis ${target.remote} et est passée dessus (git switch --track ${target.remote}).`,
      }
    }
    case 'detach': {
      const short = target.hash.slice(0, 7)

      return {
        kind: 'switch',
        args: ['switch', '--detach', target.hash],
        title: `⎇ Détacher HEAD sur ${short}`,
        details: ['HEAD détachée : un commit fait ici n’appartiendra à aucune branche.', ...kept],
        confirm: 'détacher',
        success: `✓ HEAD détachée sur ${short}`,
        note: `[gittree] Via le panneau, la personne a détaché HEAD sur ${short} (git switch --detach ${short}).`,
      }
    }
  }
}

/** Why `name` cannot be a new tag, or null when it can. */
export function tagNameError(name: string, existing: readonly string[]): string | null {
  if (name.trim() === '') return 'donne un nom au tag'
  if (existing.includes(name)) return `le tag ${name} existe déjà`
  if (!isSafeRefName(name)) return 'nom refusé par git : ni espace, ni .. ~ ^ : ? * [ \\, ni - ou . au début'

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
  const short = commit.hash.slice(0, 7)
  const text = message.trim() || name

  return {
    kind: 'tag',
    args: ['tag', '-a', name, '-m', text, commit.hash],
    title: `◇ Créer le tag ${name} sur ${short}`,
    details: [`« ${commit.subject} »`, 'tag annoté : il partira avec le prochain push'],
    confirm: 'créer',
    success: `✓ Tag ${name} créé sur ${short}`,
    note: `[gittree] Via le panneau, la personne a créé le tag annoté ${name} sur ${short} « ${commit.subject} ».`,
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
  const head = snapshot.head
  const at = { cwd: snapshot.repo.toplevel }
  const blocked = (reason: string, title = '↑ Push impossible'): PushPlan => ({ kind: 'blocked', title, reason })

  if (head.kind === 'detached') return blocked('HEAD détachée : aucune branche à pousser.')
  if (head.hash === null) return blocked('Aucun commit à pousser.')

  const branch = snapshot.refs.find(ref => ref.kind === 'branch' && ref.name === head.branch)
  const listed = await git(Cmd.remotes(), at)
  const remotes = listed.code === 0 ? listed.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []

  if (remotes.length === 0) return blocked('Aucun dépôt distant : ajoute-en un avec git remote add.')

  const upstream = branch?.upstream && !branch.isUpstreamGone ? branch.upstream : null
  const remote = upstream
    ? remotes.filter(name => upstream.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0]
    : remotes.includes('origin') ? 'origin' : remotes[0]

  if (!remote) return blocked(`${head.branch} suit ${upstream}, qui n’est pas une branche distante.`)

  const behind = branch?.track?.[1] ?? 0

  if (upstream && behind > 0) {
    return blocked(`${upstream} a ${plural(behind, 'commit', 'commits')} que tu n’as pas : récupère-les d’abord (pas de push forcé).`)
  }

  const remoteBranch = upstream ? upstream.slice(remote.length + 1) : head.branch
  const [commits, merged, remoteTags] = await Promise.all([
    git(Cmd.rangeLog(upstream ? [`${upstream}..HEAD`] : ['HEAD', '--not', '--remotes']), at),
    git(Cmd.mergedTags(), at),
    git(Cmd.remoteTags(remote), { ...at, env, timeoutMs: 20_000 }),
  ])

  if (remoteTags.code !== 0) {
    return blocked(`${remote} injoignable : ${firstLine(remoteTags.stderr) || 'git ls-remote a échoué'}`)
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
    return blocked(`Rien à pousser : ${upstream} est à jour.`, '↑ Déjà à jour')
  }

  const refspec = remoteBranch === head.branch ? head.branch : `${head.branch}:refs/heads/${remoteBranch}`
  const count =
    outgoing.length > 50 ? 'plus de 50 commits' : outgoing.length === 0 ? 'aucun commit' : plural(outgoing.length, 'commit', 'commits')
  const shown = outgoing.slice(0, 3).map(commit => `${commit.hash.slice(0, 7)} ${commit.subject}`)

  return {
    kind: 'ready',
    action: {
      kind: 'push',
      args: ['push', '--follow-tags', ...(upstream ? [] : ['-u']), remote, refspec],
      title: `↑ Pousser ${head.branch} vers ${remote}/${remoteBranch}`,
      details: [
        ...(upstream ? [] : [`crée ${remote}/${remoteBranch} et la suit (-u)`]),
        `${count}${shown.length ? ' : ' : ''}${shown.join(' · ')}`,
        ...(tags.length ? [`${plural(tags.length, 'tag', 'tags')} : ${tags.join(', ')}`] : []),
      ],
      confirm: 'pousser',
      success: `✓ Poussé : ${head.branch} → ${remote}/${remoteBranch}`,
      note: `[gittree] Via le panneau, la personne a poussé ${head.branch} vers ${remote}/${remoteBranch} (${count}${tags.length ? `, tags ${tags.join(', ')}` : ''}).`,
    },
  }
}

/**
 * Whether `args` (after `git`) is one of the writes this module builds:
 * `switch <branch>`, `switch --track <remote>/<branch>`, `switch --detach
 * <hash>`, `tag -a <name> -m <message> <hash>`, `push --follow-tags [-u]
 * <remote> <branch>[:refs/heads/<branch>]`. Nothing forced, nothing deleted.
 */
export function isAllowedWrite(args: readonly string[]): boolean {
  const [command, ...rest] = args
  const [a = '', b = '', c = '', d = '', e = ''] = rest

  switch (command) {
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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/^fatal: /, '') ?? ''
}
