import { describe, expect, test } from 'claude-code/testing'

import { isAllowedWrite } from '../src/git-actions'
import { appended, journalEntry, type JournalEntry, JOURNAL_SIZE, type RefState, ZERO } from '../src/journal'
import { groupStart, rewindLosses, rewindPlan, type RewindPlan, rewindStart, turnGroups } from '../src/rewind'
import type { GitRunner } from '../src/types'
import { h } from './fixtures'

const [M0, M1, T1, T2, M2, T3, MM, S1] = [h('a'), h('b'), h('c'), h('d'), h('e'), h('f'), h('1'), h('5')]

/** A repository the tests move as git would, and the journal of what each command did. */
function repository() {
  const sim: RefState = { refs: { 'refs/heads/main': M0, 'refs/remotes/origin/main': M0 }, head: { branch: 'main', hash: M0 } }
  let journal: JournalEntry[] = []
  let clock = 1000

  const copy = (): RefState => ({ refs: { ...sim.refs }, head: { ...sim.head } })
  const set = (ref: string, hash: string | null) => {
    if (hash === null) delete sim.refs[ref]
    else sim.refs[ref] = hash

    if (sim.head.branch && ref === `refs/heads/${sim.head.branch}`) sim.head = { ...sim.head, hash }
  }
  const go = (branch: string) => {
    sim.head = { branch, hash: sim.refs[`refs/heads/${branch}`] ?? null }
  }

  return {
    sim,
    get journal() {
      return journal
    },
    set,
    go,
    /** One of Claude's commands in `turn`: what it does to the refs, journaled as ctree records it. */
    run(turn: number, command: string, change: () => void, saved?: string) {
      const before = copy()

      change()

      const entry = journalEntry({ at: clock++, turn, command, isSubagent: false, before, after: copy(), prompt: `prompt ${turn}`, ...(saved ? { saved: { hash: saved, files: 1 } } : {}) })

      if (entry) journal = appended(journal, entry)
    },
    push(entry: JournalEntry) {
      journal = appended(journal, entry)
    },
    /** Runs a plan's commands as git would, each checked as git checks it. */
    apply(steps: readonly string[][]) {
      for (const [command, a = '', b = '', c = ''] of steps) {
        if (command === 'update-ref' && a === '-d') {
          expect(sim.refs[b]).toBe(c)
          set(b, null)
        } else if (command === 'update-ref') {
          expect(sim.refs[a] ?? ZERO).toBe(c)
          set(a, b)
        } else if (command === 'switch' && a === '--detach') {
          sim.head = { branch: null, hash: b }
        } else if (command === 'switch') {
          go(a)
        } else if (command === 'reset') {
          set(`refs/heads/${sim.head.branch}`, b)
        } else {
          throw new Error(`unexpected ${command}`)
        }
      }
    },
  }
}

/** The session the scenario tests rewind: seven turns, from a commit to a deleted branch, with a push between. */
function session() {
  const repo = repository()

  repo.run(1, 'git commit -am A', () => repo.set('refs/heads/main', M1))
  repo.run(2, 'git checkout -b topic', () => {
    repo.set('refs/heads/topic', M1)
    repo.go('topic')
  })
  repo.run(2, 'git commit -m B', () => repo.set('refs/heads/topic', T1))
  // Its changed files thrown away, a copy saved first.
  repo.run(3, 'git reset --hard HEAD~1', () => repo.set('refs/heads/topic', M1), S1)
  repo.run(4, 'git commit -m C', () => repo.set('refs/heads/topic', T2))
  repo.run(4, 'git switch main && git commit -m D', () => {
    repo.go('main')
    repo.set('refs/heads/main', M2)
  })
  repo.run(4, 'git switch topic && git rebase main', () => {
    repo.go('topic')
    repo.set('refs/heads/topic', T3)
  })
  repo.run(5, 'git switch main && git merge topic', () => {
    repo.go('main')
    repo.set('refs/heads/main', MM)
  })
  repo.run(6, 'git push origin main', () => repo.set('refs/remotes/origin/main', MM))
  repo.run(7, 'git branch -D topic', () => repo.set('refs/heads/topic', null))

  return repo
}

const planOf = (repo: ReturnType<typeof repository>, turn: number, elsewhere: string[] = []): RewindPlan => {
  const start = rewindStart(repo.journal, turn)
  const plan = start ? rewindPlan(repo.journal, start, { refs: { ...repo.sim.refs }, head: { ...repo.sim.head } }, elsewhere) : null

  if (!plan || 'kind' in plan) throw new Error(`no plan: ${JSON.stringify(plan)}`)

  return plan
}

describe('rewinding git to before a turn', () => {
  test('the whole session, back to before turn 1: one reset, the push said, the thrown-away files offered', () => {
    const repo = session()
    const plan = planOf(repo, 1)

    // HEAD is on main, as before turn 1: main goes back with reset --keep; topic was made and deleted since.
    expect(plan.steps).toEqual([['reset', '--keep', M0]])
    expect(plan.restore).toEqual(['stash', 'apply', S1])
    expect(plan.pushed).toEqual([{ ref: 'refs/remotes/origin/main', before: M0, now: MM }])
    expect(plan.left).toEqual([])
    expect(plan.prompt).toBe('prompt 1')
    expect(plan.entries).toHaveLength(repo.journal.length)

    for (const args of [...plan.steps, plan.restore ?? []]) {
      expect(`${args.join(' ')} → ${isAllowedWrite(args)}`).toBe(`${args.join(' ')} → true`)
    }

    repo.apply(plan.steps)

    // Every local ref where it stood before turn 1; the remote untouched.
    expect(repo.sim).toEqual({ refs: { 'refs/heads/main': M0, 'refs/remotes/origin/main': MM }, head: { branch: 'main', hash: M0 } })
  })

  test('back to before turn 5: the deleted branch made again, HEAD switched back to it, main moved back', () => {
    const repo = session()
    const plan = planOf(repo, 5)

    // The command that touches the files comes first, its branch ready: then refs alone.
    expect(plan.steps).toEqual([
      ['update-ref', 'refs/heads/topic', T3, ZERO],
      ['switch', 'topic'],
      ['update-ref', 'refs/heads/main', M2, MM],
    ])
    expect(plan.restore).toBeNull()

    repo.apply(plan.steps)

    expect(repo.sim).toEqual({
      refs: { 'refs/heads/main': M2, 'refs/heads/topic': T3, 'refs/remotes/origin/main': MM },
      head: { branch: 'topic', hash: T3 },
    })
  })

  test('back to before turn 2: the branch made in it goes, HEAD back on main', () => {
    const repo = session()

    // Up to turn 4, so that topic still exists.
    const early = repository()

    early.run(1, 'git commit -am A', () => early.set('refs/heads/main', M1))
    early.run(2, 'git checkout -b topic', () => {
      early.set('refs/heads/topic', M1)
      early.go('topic')
    })
    early.run(2, 'git commit -m B', () => early.set('refs/heads/topic', T1))

    const plan = planOf(early, 2)

    expect(plan.steps).toEqual([['switch', 'main'], ['update-ref', '-d', 'refs/heads/topic', T1]])

    early.apply(plan.steps)
    expect(early.sim).toEqual({ refs: { 'refs/heads/main': M1, 'refs/remotes/origin/main': M0 }, head: { branch: 'main', hash: M1 } })
    expect(repo.journal.length).toBeGreaterThan(early.journal.length)
  })

  test('a branch moved outside the journal is left as it is, and said', () => {
    const repo = session()

    // The person moves main by hand after Claude's commands.
    repo.set('refs/heads/main', h('9'))

    const plan = planOf(repo, 1)

    expect(plan.left).toEqual([{ kind: 'moved-outside', ref: 'refs/heads/main' }])
    expect(plan.steps).toEqual([])
    expect(plan.restore).toEqual(['stash', 'apply', S1])
  })

  test('HEAD moved outside the journal stays where it is; its branch, still Claude’s, goes back', () => {
    const repo = repository()

    repo.run(1, 'git commit -am A', () => repo.set('refs/heads/main', M1))
    repo.run(1, 'git branch side', () => repo.set('refs/heads/side', M1))
    // The person switches to side by hand.
    repo.go('side')

    const plan = planOf(repo, 1)

    // side is the current branch now: it is not deleted under HEAD.
    expect(plan.left).toEqual([{ kind: 'head-outside' }, { kind: 'current-kept', ref: 'refs/heads/side' }])
    expect(plan.steps).toEqual([['update-ref', 'refs/heads/main', M0, M1]])
  })

  test('a branch checked out in another worktree is left alone', () => {
    const repo = repository()

    repo.run(1, 'git branch wt-branch', () => repo.set('refs/heads/wt-branch', M1))
    repo.run(1, 'git commit -am A', () => repo.set('refs/heads/main', M1))

    const plan = planOf(repo, 1, ['wt-branch'])

    expect(plan.left).toEqual([{ kind: 'elsewhere', ref: 'refs/heads/wt-branch' }])
    expect(plan.steps).toEqual([['reset', '--keep', M0]])
  })

  test('an entry undone already counts where its undo left the ref; a rewind’s own moves count too', () => {
    const repo = repository()

    repo.run(1, 'git commit -am A', () => repo.set('refs/heads/main', M1))
    repo.run(2, 'git commit -am B', () => repo.set('refs/heads/main', M2))

    // B was undone by hand from the journal: main is back on M1.
    const [b, ...rest] = repo.journal

    repo.set('refs/heads/main', M1)

    const journal = [{ ...b!, isUndone: true as const }, ...rest]
    const plan = rewindPlan(journal, rewindStart(journal, 1)!, { refs: { ...repo.sim.refs }, head: { ...repo.sim.head } })

    expect('kind' in plan ? plan : plan.steps).toEqual([['reset', '--keep', M0]])
  })

  test('nothing to put back, or a journal that lost the turn’s start, is said rather than run', () => {
    const repo = repository()

    repo.run(1, 'git commit -am A', () => repo.set('refs/heads/main', M1))
    repo.set('refs/heads/main', M0)

    // The person put main back by hand: nothing left for the rewind.
    const done = planOf(repo, 1)

    expect([done.steps, done.restore]).toEqual([[], null])

    // A full journal whose oldest entry starts the turn: entries of it may have gone.
    const full = Array.from({ length: JOURNAL_SIZE }, (_, i): JournalEntry => ({
      id: String(i), at: i, turn: 9, command: 'git commit', isSubagent: false, moves: [], head: { before: { branch: 'main', hash: M0 }, after: { branch: 'main', hash: M0 } },
    }))

    expect(rewindPlan(full, String(JOURNAL_SIZE - 1), repo.sim)).toEqual({ kind: 'incomplete' })
    expect(rewindPlan(full, 'no such entry', repo.sim)).toEqual({ kind: 'nothing' })
  })
})

describe('turns as the journal draws them', () => {
  test('runs of one turn, newest first; a turn number that comes back after Claude Code’s /rewind is its own run', () => {
    const repo = repository()

    repo.run(1, 'git commit -am A', () => repo.set('refs/heads/main', M1))
    repo.run(2, 'git commit -am B', () => repo.set('refs/heads/main', M2))
    repo.run(2, 'git tag v1', () => repo.set('refs/tags/v1', M2))
    repo.run(3, 'git commit -am C', () => repo.set('refs/heads/main', T2))
    // The conversation went back to before turn 2, git did not; its new turn 2 commits again.
    repo.run(2, 'git commit -am B2', () => repo.set('refs/heads/main', T1))

    const groups = turnGroups(repo.journal)

    expect(groups.map(group => [group.turn, group.prompt, group.entries.map(entry => entry.command)])).toEqual([
      [2, 'prompt 2', ['git commit -am B2']],
      [3, 'prompt 3', ['git commit -am C']],
      [2, 'prompt 2', ['git tag v1', 'git commit -am B']],
      [1, 'prompt 1', ['git commit -am A']],
    ])
    expect(groupStart(groups[2]!)?.command).toBe('git commit -am B')

    // A /rewind to before turn 2 again: from the oldest of the newest run of turns 2 and later, back to turn 1's end.
    expect(repo.journal.find(entry => entry.id === rewindStart(repo.journal, 2))?.command).toBe('git commit -am B')
    // The conversation has no turn 3 now: its new turn 2 is the newest.
    expect(rewindStart(repo.journal, 3)).toBeNull()
    expect(rewindStart(repo.journal, 9)).toBeNull()
  })
})

describe('what a rewind loses, read before it runs', () => {
  test('commits only the moving refs reach, held by no local ref nor remote after; what a pushed remote keeps', async () => {
    const repo = session()
    const plan = planOf(repo, 1)
    const asked: string[] = []
    const git: GitRunner = async (args, options) => {
      asked.push(options?.stdin ?? '')

      const subject = asked.length === 1 ? 'Merge topic' : 'Release'

      return { code: 0, stdout: `${MM}\x1f${M2}\x1fA\x1fa@e.st\x1f0\x1f${subject}\0`, stderr: '' }
    }
    const losses = await rewindLosses(git, '/r', plan, { refs: { ...repo.sim.refs }, head: { ...repo.sim.head } })

    // From where main stands now, not from where every local ref will stand, nor from origin/main.
    expect(asked[0]?.split('\n').filter(Boolean).sort()).toEqual([MM, `^${M0}`, `^${MM}`].sort())
    // What origin/main keeps: from it, not from the local refs after (remotes not excluded).
    expect(asked[1]?.split('\n').filter(Boolean).sort()).toEqual([MM, `^${M0}`].sort())
    expect(losses).toEqual({
      orphaned: { count: 1, isCut: false, named: ['1111111 Merge topic'] },
      kept: [{ ref: 'refs/remotes/origin/main', commits: { count: 1, isCut: false, named: ['1111111 Release'] } }],
    })
  })
})
