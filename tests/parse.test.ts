import { describe, expect, test } from 'claude-code/testing'

import { isReadOnly } from '../src/git-commands'
import * as Cmd from '../src/git-commands'
import { loadCommits } from '../src/repo'
import {
  hunksOf,
  joinChanges,
  parseHead,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRepoInfo,
  parseStashes,
  parseStatus,
  parseWorktrees,
} from '../src/git-parse'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const T = 'e'.repeat(40)

describe('parsing what git prints', () => {
  test('log: one record per commit, merges keep both parents, a subject keeps its spaces', () => {
    const out =
      `${A}\x1f${B}\x1fNathan Test\x1ft@e.st\x1f1793005200\x1fPanneau : colonnes adaptatives\0` +
      `${B}\x1f${C} ${A}\x1fLéa\x1fl@e.st\x1f1792918800\x1fMerge branch 'feature/lanes'\0`

    expect(parseLog(out)).toEqual([
      { hash: A, parents: [B], author: 'Nathan Test', email: 't@e.st', time: 1793005200, subject: 'Panneau : colonnes adaptatives' },
      { hash: B, parents: [C, A], author: 'Léa', email: 'l@e.st', time: 1792918800, subject: "Merge branch 'feature/lanes'" },
    ])
  })

  test('log: a root commit has no parents, and noise between records is skipped', () => {
    expect(parseLog(`\n${A}\x1f\x1fX\x1fx@e.st\x1f1\x1finit\0garbage\0`)).toEqual([
      { hash: A, parents: [], author: 'X', email: 'x@e.st', time: 1, subject: 'init' },
    ])
  })

  test('refs: branches with upstream and tracking, remotes without HEAD, annotated tags peeled', () => {
    const out = [
      `refs/heads/main\x1f${A}\x1f\x1forigin/main\x1fahead 2, behind 1\x1f`,
      `refs/heads/old\x1f${B}\x1f\x1forigin/old\x1fgone\x1f`,
      `refs/remotes/origin/HEAD\x1f${A}\x1f\x1f\x1f\x1frefs/remotes/origin/main`,
      `refs/remotes/origin/main\x1f${A}\x1f\x1f\x1f\x1f`,
      `refs/tags/v1\x1f${T}\x1f${C}\x1f\x1f\x1f`,
      '',
    ].join('\n')

    expect(parseRefs(out)).toEqual([
      { kind: 'branch', name: 'main', target: A, upstream: 'origin/main', isUpstreamGone: false, track: [2, 1] },
      { kind: 'branch', name: 'old', target: B, upstream: 'origin/old', isUpstreamGone: true, track: [0, 0] },
      { kind: 'remote', name: 'origin/main', target: A },
      { kind: 'tag', name: 'v1', target: C },
    ])
  })

  test('HEAD: on a branch, detached, or on a branch with no commit yet', () => {
    expect(parseHead({ code: 0, stdout: 'refs/heads/main\n' }, { code: 0, stdout: `${A}\n` })).toEqual({ kind: 'branch', branch: 'main', hash: A })
    expect(parseHead({ code: 1, stdout: '' }, { code: 0, stdout: `${A}\n` })).toEqual({ kind: 'detached', hash: A })
    expect(parseHead({ code: 0, stdout: 'refs/heads/main\n' }, { code: 1, stdout: '' })).toEqual({ kind: 'branch', branch: 'main', hash: null })
  })

  test('status: modified, added, untracked, conflicted, and a rename with its source', () => {
    const out = ' M src/a.ts\0A  b.ts\0?? new file.txt\0UU c.ts\0R  d2.ts\0d1.ts\0 D gone.ts\0'

    expect(parseStatus(out)).toEqual([
      { path: 'src/a.ts', code: 'M' },
      { path: 'b.ts', code: 'A' },
      { path: 'new file.txt', code: '?' },
      { path: 'c.ts', code: 'U' },
      { path: 'd2.ts', code: 'R', oldPath: 'd1.ts' },
      { path: 'gone.ts', code: 'D' },
    ])
  })

  test('numstat and name-status join into file changes, renames and binaries included', () => {
    const numstat = '12\t3\tsrc/a.ts\0-\t-\tlogo.png\0' + '4\t4\t\0old.ts\0new.ts\0'
    const names = 'M\0src/a.ts\0A\0logo.png\0R087\0old.ts\0new.ts\0'

    expect(joinChanges(parseNameStatus(names), parseNumstat(numstat))).toEqual([
      { status: 'M', path: 'src/a.ts', added: 12, deleted: 3 },
      { status: 'A', path: 'logo.png', added: null, deleted: null },
      { status: 'R', path: 'new.ts', oldPath: 'old.ts', added: 4, deleted: 4 },
    ])
  })

  test('worktrees: each block with its HEAD and branch, a detached one without', () => {
    const out = 'worktree /repo\nHEAD ' + A + '\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD ' + B + '\ndetached\n\n'

    expect(parseWorktrees(out)).toEqual([
      { path: '/repo', head: A, branch: 'main' },
      { path: '/repo-wt', head: B },
    ])
  })

  test('repository info tells a linked worktree from the main one', () => {
    expect(parseRepoInfo('/r\n/r/.git\n/r/.git\n')).toMatchObject({ name: 'r', isLinkedWorktree: false })
    expect(parseRepoInfo('/wt\n/r/.git/worktrees/wt\n/r/.git\n')).toMatchObject({ name: 'wt', isLinkedWorktree: true })
    expect(parseRepoInfo('')).toBeNull()
  })

  test('a diff is cut to its hunks; a binary one says so', () => {
    const diff = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'

    expect(hunksOf(diff)).toEqual({ kind: 'hunks', source: '@@ -1 +1 @@\n-a\n+b' })
    expect(hunksOf('diff --git a/p b/p\nBinary files a/p and b/p differ\n')).toEqual({ kind: 'binary' })
    expect(hunksOf('')).toEqual({ kind: 'empty' })
  })
})

describe('the commands are reads', () => {
  test('every command the mod builds passes the read-only guard', () => {
    const built = [
      Cmd.repoInfo(),
      Cmd.headRef(),
      Cmd.headCommit(),
      Cmd.userEmail(),
      Cmd.refs(),
      Cmd.status(),
      Cmd.worktrees(),
      Cmd.log({ skip: 0, count: 100, withHead: true, scope: { kind: 'all' } }),
      Cmd.log({ skip: 100, count: 100, withHead: true, scope: { kind: 'focus', ref: 'refs/heads/main', label: 'main', isFirstParent: true } }),
      Cmd.sessionCommits({ withHead: true, email: 'a+b@c.d' }),
      Cmd.commitNumstat(A, B),
      Cmd.commitNumstat(A, undefined),
      Cmd.commitNameStatus(A, B),
      Cmd.worktreeNumstat(true),
      Cmd.untrackedNumstat('x'),
      Cmd.commitFileDiff(A, B, 'x', 'y'),
      Cmd.worktreeFileDiff('x'),
      Cmd.untrackedFileDiff('x'),
      Cmd.stashes(),
      Cmd.searchLog({ kind: 'message', text: '--exec=x' }, { kind: 'all' }, true),
      Cmd.searchLog({ kind: 'author', text: 'léa' }, { kind: 'focus', ref: 'refs/heads/main', label: 'main', isFirstParent: true }, true),
      Cmd.searchLog({ kind: 'path', text: 'src/*.ts' }, { kind: 'all' }, false),
      Cmd.rangeNumstat(A, B),
      Cmd.rangeNameStatus(A, null),
      Cmd.rangeFileDiff(A, B, 'x', 'y'),
      Cmd.rangeFileDiff(A, null, 'x'),
    ]

    for (const args of built) {
      expect(`${args.join(' ')} → ${isReadOnly(args)}`).toBe(`${args.join(' ')} → true`)
    }
  })

  test('a search keeps the text inside its option, and a path search reads it literally', () => {
    expect(Cmd.searchLog({ kind: 'message', text: '-p' }, { kind: 'all' }, true)).toContain('--grep=-p')
    expect(Cmd.searchLog({ kind: 'path', text: 'a*[b]' }, { kind: 'all' }, true).at(-1)).toBe(':(glob,icase)**/*a\\*\\[b]*')
  })

  test('commands that write, or reads in a writing form, are refused', () => {
    const refused = [
      ['commit', '-m', 'x'],
      ['push'],
      ['checkout', 'main'],
      ['reset', '--hard'],
      ['tag', 'v1'],
      ['branch', '-D', 'x'],
      ['config', 'user.email', 'x'],
      ['symbolic-ref', 'HEAD', 'refs/heads/x'],
      ['worktree', 'add', '../x'],
      ['status'],
      ['log', '--output=/tmp/x'],
      ['diff', '--ext-diff'],
      ['diff', '--textconv'],
      [],
    ]

    for (const args of refused) {
      expect(`${args.join(' ')} → ${isReadOnly(args)}`).toBe(`${args.join(' ')} → false`)
    }
  })

  test('the session query escapes the email and reads the starting tips from stdin', () => {
    expect(Cmd.sessionCommits({ withHead: false, email: 'a.b+c@d.e' })).toEqual([
      'rev-list', '--max-count=1000', '--committer=<a\\.b\\+c@d\\.e>', '--branches', '--stdin',
    ])
  })
})

describe('stashes', () => {
  test('each with the commit it was made on, its selector and its message', () => {
    const out = [
      [A, `${B} ${'c'.repeat(40)}`, 'Nathan', 'n@e.st', '1700000000', 'stash@{0}', 'On main: essai'].join('\x1f'),
      [B, `${A} ${'c'.repeat(40)} ${'d'.repeat(40)}`, 'Léa', 'l@e.st', '1600000000', 'stash@{1}', 'WIP on main: 1234567 x'].join('\x1f'),
      'noise',
    ].join('\0')

    expect(parseStashes(out)).toEqual([
      { hash: A, base: B, selector: 'stash@{0}', author: 'Nathan', email: 'n@e.st', time: 1700000000, subject: 'On main: essai' },
      { hash: B, base: A, selector: 'stash@{1}', author: 'Léa', email: 'l@e.st', time: 1600000000, subject: 'WIP on main: 1234567 x' },
    ])
  })
})

describe('a first-parent log', () => {
  test('keeps each merge on its line, its merged parents dropped, still a merge', async () => {
    const out = `${A}\x1f${B} ${C}\x1fX\x1fx@e.st\x1f1\x1fMerge topic\0${B}\x1f\x1fX\x1fx@e.st\x1f0\x1froot\0`
    const page = await loadCommits(async () => ({ code: 0, stdout: out, stderr: '' }), '/r', {
      skip: 0,
      count: 100,
      withHead: true,
      scope: { kind: 'focus', ref: 'refs/heads/main', label: 'main', isFirstParent: true },
    })

    expect(page.commits[0]).toMatchObject({ hash: A, parents: [B], isMerge: true })
    expect(page.commits[1]?.isMerge).toBeUndefined()
  })
})
