import { describe, expect, test } from 'claude-code/testing'

import { consequences, gitCalls, keepsFiles, type Risk, riskOf } from '../src/guard'
import type { GitRunner } from '../src/types'
import { h } from './fixtures'

const riskIn = (command: string): Risk | null => {
  const [call] = gitCalls(command)

  return call ? riskOf(call) : null
}

describe('reading the git commands in a shell command', () => {
  test('past cd, env assignments, quotes, chains and git’s own options', () => {
    const calls = gitCalls(`cd app && GIT_DIR=x git -c core.pager=cat --no-pager reset --hard "HEAD~2"; echo ok | git log -n1`)

    expect(calls.map(call => [call.subcommand, call.args])).toEqual([
      ['reset', ['--hard', 'HEAD~2']],
      ['log', ['-n1']],
    ])
  })

  test('a git run in another repository says so', () => {
    expect(gitCalls('git -C ../other clean -fd')[0]?.isElsewhere).toBe(true)
    expect(gitCalls('git status')[0]?.isElsewhere).toBe(false)
  })

  test('a quoted git is text, not a command', () => {
    expect(gitCalls(`echo "git reset --hard"`)).toEqual([])
  })
})

describe('what is risky', () => {
  const cases: [string, Risk | null][] = [
    ['git reset --hard', { kind: 'reset-hard', target: 'HEAD' }],
    ['git reset --hard origin/main', { kind: 'reset-hard', target: 'origin/main' }],
    ['git reset --soft HEAD~1', null],
    ['git reset HEAD~1', null],
    ['git checkout -- .', { kind: 'discard', paths: ['.'] }],
    ['git checkout .', { kind: 'discard', paths: ['.'] }],
    ['git checkout main -- src/a.ts', { kind: 'discard', paths: ['src/a.ts'] }],
    ['git checkout -f main', { kind: 'discard', paths: [] }],
    ['git checkout feature', null],
    ['git restore src/a.ts', { kind: 'discard', paths: ['src/a.ts'] }],
    ['git restore --staged src/a.ts', null],
    ['git switch --discard-changes main', { kind: 'discard', paths: [] }],
    ['git switch main', null],
    ['git clean -fdx', { kind: 'clean', dirs: true, ignored: 'also', paths: [] }],
    ['git clean -n -d', null],
    ['git stash drop stash@{2}', { kind: 'stash-drop', which: 'stash@{2}' }],
    ['git stash clear', { kind: 'stash-clear' }],
    ['git stash pop', null],
    ['git push -f origin main', { kind: 'force-push', remote: 'origin', refspecs: ['main'] }],
    ['git push --force-with-lease', { kind: 'force-push', remote: null, refspecs: [] }],
    ['git push origin +feature', { kind: 'force-push', remote: 'origin', refspecs: ['feature'] }],
    ['git push origin --delete old', { kind: 'push-delete', remote: 'origin', branches: ['old'] }],
    ['git push origin :old', { kind: 'push-delete', remote: 'origin', branches: ['old'] }],
    ['git push -u origin feature', null],
    ['git branch -D old', { kind: 'branch-delete', branches: ['old'] }],
    ['git branch -d -f old', { kind: 'branch-delete', branches: ['old'] }],
    ['git branch -d old', null],
    ['git rebase main', null],
    ['git commit --amend --no-edit', null],
    ['git gc --prune=now', { kind: 'other', what: 'supprime pour de bon les commits que plus rien ne référence' }],
  ]

  for (const [command, risk] of cases) {
    test(command, () => {
      expect(riskIn(command)).toEqual(risk)
    })
  }
})

describe('what a risky command would lose, read before it runs', () => {
  const log = (...subjects: string[]) =>
    subjects.map((subject, i) => `${String(i + 1).repeat(40)}\x1f\x1fA\x1fa@e.st\x1f0\x1f${subject}\0`).join('')

  /** git answering the guard's reads from a few facts. */
  const git =
    (facts: { lost?: string; target?: boolean; clean?: string; stash?: string }): GitRunner =>
    async args => {
      const [command] = args

      if (command === 'rev-parse') return facts.target === false ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${h('9')}\n`, stderr: '' }
      if (command === 'log') return { code: 0, stdout: facts.lost ?? '', stderr: '' }
      if (command === 'clean') return { code: 0, stdout: facts.clean ?? '', stderr: '' }
      if (command === 'stash') return { code: 0, stdout: facts.stash ?? '', stderr: '' }

      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
    }
  const context = {
    toplevel: '/r',
    branch: 'main',
    status: [
      { path: 'src/a.ts', code: 'M' },
      { path: 'src/b.ts', code: 'M' },
      { path: 'notes.txt', code: '?' },
    ],
  }

  test('reset --hard: the commits no branch will hold, and the changes lost', async () => {
    const lines = await consequences(git({ lost: log('Un', 'Deux', 'Trois') }), { kind: 'reset-hard', target: 'HEAD~3' }, context)

    expect(lines).toEqual([
      '3 commits (1111111 Un · 2222222 Deux · …) ne seront plus sur aucune branche',
      '2 fichiers modifiés perdus : src/a.ts, src/b.ts',
    ])
  })

  test('checkout of a path: only the changes under it', async () => {
    expect(await consequences(git({}), { kind: 'discard', paths: ['src/a.ts'] }, context)).toEqual(['1 fichier modifié perdu : src/a.ts'])
    expect(await consequences(git({}), { kind: 'discard', paths: ['docs'] }, context)).toEqual([])
  })

  test('clean -f: what git says it would remove, no copy possible', async () => {
    const lines = await consequences(git({ clean: 'Would remove notes.txt\nWould remove tmp/\n' }), { kind: 'clean', dirs: true, ignored: 'no', paths: [] }, context)

    expect(lines).toEqual(['2 fichiers non suivis supprimés, sans copie possible : notes.txt, tmp/'])
  })

  test('stash drop: the stash it names', async () => {
    const lines = await consequences(git({ stash: 'stash@{0}\x1fWIP on main: tests\nstash@{1}\x1fWIP on main: old\n' }), { kind: 'stash-drop', which: 'stash@{1}' }, context)

    expect(lines).toEqual(['1 stash perdu : stash@{1} WIP on main: old'])
  })

  test('push --force: the commits the remote branch would lose', async () => {
    const lines = await consequences(git({ lost: log('Du collègue') }), { kind: 'force-push', remote: 'origin', refspecs: [] }, context)

    expect(lines).toEqual(['origin/main perd 1 commit (1111111 Du collègue)'])
  })

  test('branch -D: the commits only that branch holds', async () => {
    const lines = await consequences(git({ lost: log('Essai') }), { kind: 'branch-delete', branches: ['spike'] }, context)

    expect(lines).toEqual(['spike : 1 commit (1111111 Essai) n’existent que sur elle'])
  })

  test('staging and committing leave the files alone; a reset does not', () => {
    expect(keepsFiles('git add -A && git commit -m x')).toBe(true)
    expect(keepsFiles('git commit -am x')).toBe(true)
    expect(keepsFiles('git commit --amend --no-edit')).toBe(true)
    expect(keepsFiles('git reset --hard')).toBe(false)
  })
})
