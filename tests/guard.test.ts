import { describe, expect, test } from 'claude-code/testing'

import { consequences, gitCalls, keepsFiles, type Loss, lossText, type Risk, riskOf } from '../src/guard'
import { messages } from '../src/i18n'
import type { GitRunner } from '../src/types'
import { h, inBoth } from './fixtures'

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
    ['git gc --prune=now', { kind: 'other', what: 'prune' }],
    ['git update-ref -d refs/heads/x', { kind: 'other', what: 'delete-ref', ref: 'refs/heads/x' }],
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

  /** What a risk loses, worded in the language the test runs in. */
  const said = async (risk: Risk, facts: Parameters<typeof git>[0] = {}) =>
    (await consequences(git(facts), risk, context)).map(loss => lossText(loss))

  inBoth('reset --hard: the commits no branch will hold, and the changes lost', async say => {
    const losses = await consequences(git({ lost: log('Un', 'Deux', 'Trois') }), { kind: 'reset-hard', target: 'HEAD~3' }, context)

    expect(losses).toEqual([
      { kind: 'orphaned', commits: { count: 3, isCut: false, named: ['1111111 Un', '2222222 Deux'] } },
      { kind: 'changes', files: ['src/a.ts', 'src/b.ts'] },
    ])
    expect(losses.map(loss => lossText(loss))).toEqual(say([
      '3 commits (1111111 Un · 2222222 Deux · …) will no longer be on any branch',
      '2 changed files lost: src/a.ts, src/b.ts',
    ], [
      '3 commits (1111111 Un · 2222222 Deux · …) ne seront plus sur aucune branche',
      '2 fichiers modifiés perdus : src/a.ts, src/b.ts',
    ]))
  })

  inBoth('checkout of a path: only the changes under it', async say => {
    expect(await said({ kind: 'discard', paths: ['src/a.ts'] })).toEqual([say('1 changed file lost: src/a.ts', '1 fichier modifié perdu : src/a.ts')])
    expect(await said({ kind: 'discard', paths: ['docs'] })).toEqual([])
  })

  inBoth('clean -f: what git says it would remove, no copy possible', async say => {
    expect(await said({ kind: 'clean', dirs: true, ignored: 'no', paths: [] }, { clean: 'Would remove notes.txt\nWould remove tmp/\n' })).toEqual([say(
      '2 untracked files deleted, with no copy possible: notes.txt, tmp/',
      '2 fichiers non suivis supprimés, sans copie possible : notes.txt, tmp/',
    )])
  })

  inBoth('stash drop: the stash it names', async say => {
    const stash = 'stash@{0}\x1fWIP on main: tests\nstash@{1}\x1fWIP on main: old\n'

    expect(await said({ kind: 'stash-drop', which: 'stash@{1}' }, { stash })).toEqual([say('1 stash lost: stash@{1} WIP on main: old', '1 stash perdu : stash@{1} WIP on main: old')])
  })

  inBoth('push --force: the commits the remote branch would lose', async say => {
    expect(await said({ kind: 'force-push', remote: 'origin', refspecs: [] }, { lost: log('Du collègue') })).toEqual([say(
      'origin/main loses 1 commit (1111111 Du collègue)',
      'origin/main perd 1 commit (1111111 Du collègue)',
    )])
  })

  inBoth('branch -D: the commits only that branch holds', async say => {
    expect(await said({ kind: 'branch-delete', branches: ['spike'] }, { lost: log('Essai') })).toEqual([say(
      'spike: 1 commit (1111111 Essai) exist only on it',
      'spike : 1 commit (1111111 Essai) n’existent que sur elle',
    )])
  })

  inBoth('the rest is worded too, in either language, and in English for Claude whatever the language', say => {
    const losses: Loss[] = [
      { kind: 'other', what: 'prune' },
      { kind: 'other', what: 'delete-ref', ref: 'refs/heads/x' },
      { kind: 'remote-rewritten', targets: ['origin/main'] },
      { kind: 'elsewhere', command: 'git -C ../x reset --hard' },
    ]

    expect(losses.map(loss => lossText(loss))).toEqual(say([
      'deletes for good the commits nothing refers to any more',
      'deletes the ref refs/heads/x',
      'rewrites origin/main (remote state not checked)',
      'in another repository (git -C ../x reset --hard): what it loses was not checked',
    ], [
      'supprime pour de bon les commits que plus rien ne référence',
      'supprime la référence refs/heads/x',
      'réécrit origin/main (état distant non vérifié)',
      'dans un autre dépôt (git -C ../x reset --hard) : ce qu’elle perd n’a pas été vérifié',
    ]))
    expect(lossText({ kind: 'other', what: 'reflog' }, messages('en'))).toBe('erases the reflog, git’s safety net')
  })

  test('staging and committing leave the files alone; a reset does not', () => {
    expect(keepsFiles('git add -A && git commit -m x')).toBe(true)
    expect(keepsFiles('git commit -am x')).toBe(true)
    expect(keepsFiles('git commit --amend --no-edit')).toBe(true)
    expect(keepsFiles('git reset --hard')).toBe(false)
  })
})
