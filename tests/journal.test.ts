import { describe, expect, test } from 'claude-code/testing'

import { isAllowedWrite } from '../src/git-actions'
import { appended, describeMoves, diffRefs, journalEntry, type RefState, undoPlan, ZERO } from '../src/journal'
import { messages } from '../src/i18n'
import { h, inBoth } from './fixtures'

const state = (refs: Record<string, string>, branch: string | null, hash: string | null): RefState => ({ refs, head: { branch, hash } })

const entryOf = (command: string, before: RefState, after: RefState, saved?: { hash: string; files: number }) => {
  const entry = journalEntry({ at: 1000, turn: 4, command, isSubagent: false, before, after, ...(saved ? { saved } : {}) })

  if (!entry) throw new Error('no entry')

  return entry
}

describe('the journal', () => {
  inBoth('records what a command moved, and nothing for a command that moved nothing', say => {
    const before = state({ 'refs/heads/main': h('a'), 'refs/tags/v1': h('a') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('b'), 'refs/heads/topic': h('b') }, 'topic', h('b'))

    expect(diffRefs(before, after)).toEqual([
      { ref: 'refs/heads/main', before: h('a'), after: h('b') },
      { ref: 'refs/heads/topic', before: null, after: h('b') },
      { ref: 'refs/tags/v1', before: h('a'), after: null },
    ])
    expect(journalEntry({ at: 1, turn: 1, command: 'git log', isSubagent: false, before, after: before })).toBeNull()
    expect(describeMoves(entryOf('x', before, after))).toEqual(say(
      ['HEAD: main → topic', 'main aaaaaaa → bbbbbbb', 'topic created', '◇ v1 deleted (was aaaaaaa)'],
      ['HEAD : main → topic', 'main aaaaaaa → bbbbbbb', 'topic créée', '◇ v1 supprimée (était aaaaaaa)'],
    ))
    // What Claude's note says, in English whatever the language.
    expect(describeMoves(entryOf('x', before, after), messages('en'))[2]).toBe('topic created')
    const still = state({ 'refs/heads/main': h('a') }, 'main', h('a'))

    expect(describeMoves(entryOf('x', still, still, { hash: h('5'), files: 2 }))).toEqual([say('2 changed files saved first', '2 fichiers modifiés sauvés avant')])
  })

  test('a command that only threw changes away is kept, for its saved copy', () => {
    const same = state({ 'refs/heads/main': h('a') }, 'main', h('a'))
    const entry = entryOf('git checkout -- .', same, same, { hash: h('5'), files: 2 })

    expect(entry.saved).toBe(h('5'))
    expect(undoPlan(entry, same)).toEqual({ steps: [], notes: [], restore: ['stash', 'apply', h('5')] })
  })
})

test('two entries of the same millisecond get names of their own', () => {
  const still = state({ 'refs/heads/main': h('a') }, 'main', h('a'))
  const moved = state({ 'refs/heads/main': h('b') }, 'main', h('b'))
  const one = entryOf('git commit -m one', still, moved)
  const journal = appended(appended([], one), { ...one, command: 'git commit -m two' })

  expect(journal.map(entry => entry.id)).toEqual(['1000-1', '1000'])
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

  inBoth('a ref that moved again since, and a push, are left alone and said so', say => {
    const before = state({ 'refs/heads/main': h('a'), 'refs/remotes/origin/main': h('a') }, 'main', h('a'))
    const after = state({ 'refs/heads/main': h('b'), 'refs/remotes/origin/main': h('b') }, 'main', h('b'))
    const now = state({ 'refs/heads/main': h('c'), 'refs/remotes/origin/main': h('b') }, 'main', h('c'))
    const plan = undoPlan(entryOf('git commit -m x && git push', before, after), now)

    expect(plan.steps).toEqual([])
    expect(plan.notes).toEqual(say([
      'main moved since: left as it is',
      'origin/main: already on the remote, cannot be undone here (it would take a force push)',
    ], [
      'main a bougé depuis : laissé tel quel',
      'origin/main : déjà sur le dépôt distant, non annulable ici (il faudrait un push forcé)',
    ]))
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
