import { describe, expect, test } from 'claude-code/testing'

import {
  displayCommand,
  isAllowedWrite,
  isSafeRefName,
  nextVersion,
  planPush,
  switchAction,
  switchTargets,
  tagAction,
  tagNameError,
} from '../src/git-actions'
import type { GitRunner, RepoSnapshot } from '../src/types'
import { COMMITS, h, SNAPSHOT } from './fixtures'

const withRefs = (refs: RepoSnapshot['refs'], extra: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  ...SNAPSHOT,
  refs,
  ...extra,
})

describe('switching branch', () => {
  test('a commit with a local branch switches to it', () => {
    expect(switchTargets(SNAPSHOT, h('1'))).toEqual([{ kind: 'branch', branch: 'feature/ui' }])
    expect(switchAction(SNAPSHOT, { kind: 'branch', branch: 'feature/ui' }).args).toEqual(['switch', 'feature/ui'])
  })

  test('a remote branch with no local one is created, tracking it', () => {
    const targets = switchTargets(SNAPSHOT, h('4'))

    expect(targets).toEqual([{ kind: 'track', remote: 'origin/feature/lanes' }])
    expect(switchAction(SNAPSHOT, targets[0]!).args).toEqual(['switch', '--track', 'origin/feature/lanes'])
    expect(switchAction(SNAPSHOT, targets[0]!).title).toContain('Créer feature/lanes')
  })

  test('the current branch is no target; HEAD’s commit with nothing else is nothing to do', () => {
    expect(switchTargets(SNAPSHOT, h('3'))).toEqual([])
  })

  test('a commit with no branch detaches HEAD, and says so', () => {
    const targets = switchTargets(SNAPSHOT, h('6'))
    const action = switchAction(SNAPSHOT, targets[0]!)

    expect(targets).toEqual([{ kind: 'detach', hash: h('6') }])
    expect(action.args).toEqual(['switch', '--detach', h('6')])
    expect(action.details.join(' ')).toContain('HEAD détachée')
  })

  test('several branches on one commit are each offered', () => {
    const refs = withRefs([
      ...SNAPSHOT.refs,
      { kind: 'branch', name: 'hotfix', target: h('1') },
      { kind: 'remote', name: 'origin/review', target: h('1') },
    ])

    expect(switchTargets(refs, h('1'))).toEqual([
      { kind: 'branch', branch: 'feature/ui' },
      { kind: 'branch', branch: 'hotfix' },
      { kind: 'track', remote: 'origin/review' },
    ])
  })

  test('uncommitted changes are mentioned before switching', () => {
    const action = switchAction(SNAPSHOT, { kind: 'branch', branch: 'feature/ui' })

    expect(action.details[0]).toContain('2 modifications non commitées')
    expect(switchAction({ ...SNAPSHOT, status: [] }, { kind: 'branch', branch: 'x' }).details).toEqual([])
  })
})

describe('tags', () => {
  test('the next version follows the highest one, its prefix kept', () => {
    expect(nextVersion(['v0.1.0', 'v0.2.0', 'notes'])).toBe('v0.3.0')
    expect(nextVersion(['1.9.3', '1.10.0'])).toBe('1.11.0')
    expect(nextVersion(['release'])).toBe('')
  })

  test('a name is refused when empty, taken, or not a valid ref', () => {
    expect(tagNameError('', [])).toContain('nom')
    expect(tagNameError('v0.2.0', ['v0.2.0'])).toContain('existe déjà')

    for (const bad of ['v 1', 'a..b', '-x', 'x.lock', 'x/', '/x', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1', 'a\\b', '@', 'a@{1}', '.hidden']) {
      expect(`${bad} → ${tagNameError(bad, []) !== null}`).toBe(`${bad} → true`)
    }

    expect(tagNameError('release/2026-10', [])).toBeNull()
  })

  test('a tag is annotated, its message the name when none is given', () => {
    const merge = COMMITS[2]!

    expect(tagAction(merge, 'v0.3.0', '').args).toEqual(['tag', '-a', 'v0.3.0', '-m', 'v0.3.0', h('3')])
    expect(tagAction(merge, 'v0.3.0', 'Version 0.3').args[4]).toBe('Version 0.3')
  })
})

describe('the write guard', () => {
  test('admits exactly the shapes the actions build', () => {
    const allowed = [
      ['switch', 'feature/ui'],
      ['switch', '--track', 'origin/feature/lanes'],
      ['switch', '--detach', h('6')],
      ['tag', '-a', 'v1.0.0', '-m', 'Version 1, "stable"', h('3')],
      ['push', '--follow-tags', 'origin', 'main'],
      ['push', '--follow-tags', '-u', 'origin', 'feature/ui'],
      ['push', '--follow-tags', 'origin', 'feat:refs/heads/feature-x'],
    ]

    for (const args of allowed) {
      expect(`${args.join(' ')} → ${isAllowedWrite(args)}`).toBe(`${args.join(' ')} → true`)
    }
  })

  test('refuses forced, deleting and any other writes', () => {
    const refused = [
      ['push', '--force', 'origin', 'main'],
      ['push', '--follow-tags', 'origin', '+main'],
      ['push', '--follow-tags', '-f', 'origin', 'main'],
      ['push', '--follow-tags', 'origin', ':main'],
      ['push', '--follow-tags', 'origin', 'main', '--delete'],
      ['push', '--follow-tags', '--mirror', 'origin'],
      ['push', 'origin', 'main'],
      ['push', '--follow-tags', 'origin', 'main:refs/tags/x'],
      ['tag', '-d', 'v1'],
      ['tag', '-f', '-a', 'v1', '-m', 'x', h('3')],
      ['tag', '-a', 'v1', '-m', '', h('3')],
      ['tag', '-a', 'v1', '-m', 'x', 'HEAD'],
      ['switch', '-c', 'new'],
      ['switch', '--discard-changes', 'main'],
      ['switch', '-f', 'main'],
      ['switch', '--detach', 'HEAD~1'],
      ['checkout', 'main'],
      ['reset', '--hard'],
      ['branch', '-D', 'x'],
      ['commit', '-m', 'x'],
      [],
    ]

    for (const args of refused) {
      expect(`${args.join(' ')} → ${isAllowedWrite(args)}`).toBe(`${args.join(' ')} → false`)
    }
  })

  test('ref names follow git’s rules and never pass for an option', () => {
    expect(isSafeRefName('feature/ui')).toBe(true)
    expect(isSafeRefName('--force')).toBe(false)
    expect(isSafeRefName('a b')).toBe(false)
  })

  test('the confirmation shows the command short and quoted', () => {
    expect(displayCommand(['tag', '-a', 'v1', '-m', 'Version "1"', h('3')])).toBe('git tag -a v1 -m "Version \\"1\\"" 3333333')
    expect(displayCommand(['switch', 'feature/ui'])).toBe('git switch feature/ui')
  })
})

describe('planning a push', () => {
  /** git answering what planPush asks, from a few facts about the remote. */
  const remoteGit = (facts: { remotes?: string; ahead?: string; tags?: string; remoteTags?: string; isOffline?: boolean }): GitRunner =>
    async args => {
      const [command] = args

      if (command === 'remote') return { code: 0, stdout: facts.remotes ?? 'origin\n', stderr: '' }
      if (command === 'log') return { code: 0, stdout: facts.ahead ?? '', stderr: '' }
      if (command === 'tag') return { code: 0, stdout: facts.tags ?? '', stderr: '' }
      if (command === 'ls-remote') {
        return facts.isOffline
          ? { code: 128, stdout: '', stderr: 'fatal: Could not read from remote repository.' }
          : { code: 0, stdout: facts.remoteTags ?? '', stderr: '' }
      }

      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
    }
  const commitLog = (hash: string, subject: string) => `${hash}\x1f${h('9')}\x1fA\x1fa@e.st\x1f1\x1f${subject}\0`

  test('ahead of its upstream: the commits and the annotated tags the remote lacks', async () => {
    const plan = await planPush(
      remoteGit({
        ahead: commitLog(h('a'), 'Un') + commitLog(h('b'), 'Deux'),
        tags: 'v0.1.0\x1ftag\nv0.2.0\x1fcommit\nv0.3.0\x1ftag\n',
        remoteTags: `${h('7')}\trefs/tags/v0.1.0\n`,
      }),
      SNAPSHOT,
    )

    expect(plan.kind).toBe('ready')

    if (plan.kind !== 'ready') return

    expect(plan.action.args).toEqual(['push', '--follow-tags', 'origin', 'main'])
    expect(plan.action.details).toEqual(['2 commits : aaaaaaa Un · bbbbbbb Deux', '1 tag : v0.3.0'])
  })

  test('with no upstream it creates one with -u', async () => {
    const snapshot = withRefs(SNAPSHOT.refs.map(ref => (ref.name === 'main' && ref.kind === 'branch' ? { kind: 'branch', name: 'main', target: h('3') } : ref)))
    const plan = await planPush(remoteGit({ ahead: commitLog(h('a'), 'Un') }), snapshot)

    expect(plan.kind === 'ready' && plan.action.args).toEqual(['push', '--follow-tags', '-u', 'origin', 'main'])
    expect(plan.kind === 'ready' && plan.action.details[0]).toContain('crée origin/main')
  })

  test('an upstream of another name is pushed to by its full ref', async () => {
    const snapshot = withRefs(
      [{ kind: 'branch', name: 'feat', target: h('3'), upstream: 'origin/feature-x', track: [1, 0] }],
      { head: { kind: 'branch', branch: 'feat', hash: h('3') } },
    )
    const plan = await planPush(remoteGit({ ahead: commitLog(h('a'), 'Un') }), snapshot)

    expect(plan.kind === 'ready' && plan.action.args).toEqual(['push', '--follow-tags', 'origin', 'feat:refs/heads/feature-x'])
  })

  test('behind its upstream, detached, nothing to send, no remote, offline: blocked, saying why', async () => {
    const behind = withRefs(SNAPSHOT.refs.map(ref => (ref.name === 'main' && ref.kind === 'branch' ? { ...ref, track: [1, 3] as const } : ref)))
    const reasons = await Promise.all([
      planPush(remoteGit({}), behind),
      planPush(remoteGit({}), { ...SNAPSHOT, head: { kind: 'detached', hash: h('3') } }),
      planPush(remoteGit({}), SNAPSHOT),
      planPush(remoteGit({ remotes: '' }), SNAPSHOT),
      planPush(remoteGit({ isOffline: true }), SNAPSHOT),
    ])

    expect(reasons.map(plan => (plan.kind === 'blocked' ? plan.reason : 'ready'))).toEqual([
      'origin/main a 3 commits que tu n’as pas : récupère-les d’abord (pas de push forcé).',
      'HEAD détachée : aucune branche à pousser.',
      'Rien à pousser : origin/main est à jour.',
      'Aucun dépôt distant : ajoute-en un avec git remote add.',
      'origin injoignable : Could not read from remote repository.',
    ])
  })
})
