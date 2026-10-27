import { describe, expect, test } from 'claude-code/testing'

import { isAllowedWrite } from '../src/git-actions'
import { describeMoves, diffRefs, journalEntry, type RefState, undoPlan, ZERO } from '../src/journal'
import { h } from './fixtures'

const state = (refs: Record<string, string>, branch: string | null, hash: string | null): RefState => ({ refs, head: { branch, hash } })

const entryOf = (command: string, before: RefState, after: RefState, saved?: { hash: string; files: number }) => {
  const entry = journalEntry({ at: 1000, turn: 4, command, isSubagent: false, before, after, ...(saved ? { saved } : {}) })

  if (!entry) throw new Error('no entry')

  return entry
}

describe('the journal', () => {
  test('records what a command moved, and nothing for a command that moved nothing', () => {
    const before = state({ 'refs/heads/main': h('a'), 'refs/tags/v1': h('a') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('b'), 'refs/heads/topic': h('b') }, 'topic', h('b'))

    expect(diffRefs(before, after)).toEqual([
      { ref: 'refs/heads/main', before: h('a'), after: h('b') },
      { ref: 'refs/heads/topic', before: null, after: h('b') },
      { ref: 'refs/tags/v1', before: h('a'), after: null },
    ])
    expect(journalEntry({ at: 1, turn: 1, command: 'git log', isSubagent: false, before, after: before })).toBeNull()
    expect(describeMoves(entryOf('x', before, after))).toEqual([
      'HEAD : main → topic',
      'main aaaaaaa → bbbbbbb',
      'topic créée',
      '◇ v1 supprimée (était aaaaaaa)',
    ])
  })

  test('a command that only threw changes away is kept, for its saved copy', () => {
    const same = state({ 'refs/heads/main': h('a') }, 'main', h('a'))
    const entry = entryOf('git checkout -- .', same, same, { hash: h('5'), files: 2 })

    expect(entry.saved).toBe(h('5'))
    expect(undoPlan(entry, same)).toEqual({ steps: [], notes: [], restore: ['stash', 'apply', h('5')] })
  })
})

describe('undoing', () => {
  test('a commit comes undone softly: its changes come back uncommitted', () => {
    const before = state({ 'refs/heads/main': h('a') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('b') }, 'main', h('b'))

    expect(undoPlan(entryOf('git add -A && git commit -m x', before, after), after).steps).toEqual([['reset', '--soft', h('a')]])
  })

  test('a reset --hard comes undone with --keep, the thrown-away changes offered back', () => {
    const before = state({ 'refs/heads/main': h('b') }, 'main', h('b'))
    const after = state({ 'refs/heads/main': h('a') }, 'main', h('a'))
    const plan = undoPlan(entryOf('git reset --hard HEAD~1', before, after, { hash: h('5'), files: 3 }), after)

    expect(plan.steps).toEqual([['reset', '--keep', h('b')]])
    expect(plan.restore).toEqual(['stash', 'apply', h('5')])
  })

  test('checkout -b: HEAD goes back, then the new branch goes', () => {
    const before = state({ 'refs/heads/main': h('a') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('a'), 'refs/heads/topic': h('a') }, 'topic', h('a'))

    expect(undoPlan(entryOf('git checkout -b topic', before, after), after).steps).toEqual([
      ['switch', 'main'],
      ['update-ref', '-d', 'refs/heads/topic', h('a')],
    ])
  })

  test('branch -D: the branch is made again where it was', () => {
    const before = state({ 'refs/heads/main': h('a'), 'refs/heads/spike': h('c') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('a') }, 'main', h('a'))

    expect(undoPlan(entryOf('git branch -D spike', before, after), after).steps).toEqual([['update-ref', 'refs/heads/spike', h('c'), ZERO]])
  })

  test('a ref that moved again since, and a push, are left alone and said so', () => {
    const before = state({ 'refs/heads/main': h('a'), 'refs/remotes/origin/main': h('a') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('b'), 'refs/remotes/origin/main': h('b') }, 'main', h('b'))
    const now = state({ 'refs/heads/main': h('c'), 'refs/remotes/origin/main': h('b') }, 'main', h('c'))
    const plan = undoPlan(entryOf('git commit -m x && git push', before, after), now)

    expect(plan.steps).toEqual([])
    expect(plan.notes).toEqual([
      'main a bougé depuis : laissé tel quel',
      'origin/main : déjà sur le dépôt distant, non annulable ici (il faudrait un push forcé)',
    ])
  })

  test('a rebase of a branch HEAD has left since: the branch moves back, HEAD stays', () => {
    const before = state({ 'refs/heads/main': h('a'), 'refs/heads/topic': h('d') }, 'topic', h('d'))
    const after = state({ 'refs/heads/main': h('a'), 'refs/heads/topic': h('e') }, 'topic', h('e'))
    const now = state({ 'refs/heads/main': h('a'), 'refs/heads/topic': h('e') }, 'main', h('a'))

    expect(undoPlan(entryOf('git rebase main', before, after), now).steps).toEqual([['update-ref', 'refs/heads/topic', h('d'), h('e')]])
  })

  test('every undo command passes the write guard; nothing beyond them does', () => {
    for (const args of [
      ['reset', '--keep', h('b')],
      ['reset', '--soft', h('a')],
      ['update-ref', 'refs/heads/spike', h('c'), ZERO],
      ['update-ref', 'refs/heads/topic', h('d'), h('e')],
      ['update-ref', '-d', 'refs/heads/topic', h('a')],
      ['update-ref', 'refs/tags/v1', h('a'), ZERO],
      ['stash', 'apply', h('5')],
      ['stash', 'create'],
    ]) {
      expect(`${args.join(' ')} → ${isAllowedWrite(args)}`).toBe(`${args.join(' ')} → true`)
    }

    for (const args of [
      ['reset', '--hard', h('b')],
      ['reset', '--keep', 'HEAD~1'],
      ['update-ref', 'refs/remotes/origin/main', h('a'), h('b')],
      ['update-ref', 'refs/heads/main', ZERO, h('a')],
      ['update-ref', '-d', 'refs/heads/main'],
      ['update-ref', 'HEAD', h('a'), h('b')],
      ['stash', 'drop'],
      ['stash', 'apply', 'stash@{0}'],
      ['stash', 'create', 'message'],
    ]) {
      expect(`${args.join(' ')} → ${isAllowedWrite(args)}`).toBe(`${args.join(' ')} → false`)
    }
  })
})
