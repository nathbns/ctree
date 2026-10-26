// A small repository told as git would print it, for the render and pane
// tests: main with a merged feature, a branch ahead of it, a tag, a remote,
// two uncommitted files.

import type { Commit, RepoSnapshot } from '../src/types'

/** A full-length hash made of one repeated hex digit: `h('a')`. */
export const h = (digit: string): string => digit.repeat(40)

/** 2026-10-26 12:00 UTC, the tests' now. */
export const NOW = Date.UTC(2026, 9, 26, 12)

const hours = (n: number) => Math.floor(NOW / 1000) - n * 3600

export const COMMITS: Commit[] = [
  { hash: h('1'), parents: [h('2')], author: 'Nathan Test', email: 'n@e.st', time: hours(2), subject: 'Panneau : colonnes adaptatives' },
  { hash: h('2'), parents: [h('6')], author: 'Nathan Test', email: 'n@e.st', time: hours(26), subject: 'Navigation j/k' },
  { hash: h('3'), parents: [h('6'), h('4')], author: 'Nathan Test', email: 'n@e.st', time: hours(5), subject: "Merge branch 'feature/lanes'" },
  { hash: h('4'), parents: [h('5')], author: 'Léa Martin', email: 'l@e.st', time: hours(6), subject: 'Calcul des lanes : octopus merge' },
  { hash: h('5'), parents: [h('7')], author: 'Léa Martin', email: 'l@e.st', time: hours(30), subject: 'Tests du calcul des lanes' },
  { hash: h('6'), parents: [h('7')], author: 'Nathan Test', email: 'n@e.st', time: hours(50), subject: 'Étiquettes de branches' },
  { hash: h('7'), parents: [h('8')], author: 'Nathan Test', email: 'n@e.st', time: hours(80), subject: 'Parsing de git log' },
  { hash: h('8'), parents: [], author: 'Nathan Test', email: 'n@e.st', time: hours(500), subject: 'Commit initial' },
]

export const SNAPSHOT: RepoSnapshot = {
  kind: 'repo',
  repo: { toplevel: '/work/demo', name: 'demo', gitDir: '/work/demo/.git', commonDir: '/work/demo/.git', isLinkedWorktree: false },
  head: { kind: 'branch', branch: 'main', hash: h('3') },
  refs: [
    { kind: 'branch', name: 'feature/ui', target: h('1') },
    { kind: 'branch', name: 'main', target: h('3'), upstream: 'origin/main', track: [0, 0], isUpstreamGone: false },
    { kind: 'remote', name: 'origin/feature/lanes', target: h('4') },
    { kind: 'remote', name: 'origin/main', target: h('3') },
    { kind: 'tag', name: 'v0.1.0', target: h('7') },
    { kind: 'tag', name: 'v0.2.0', target: h('3') },
  ],
  commits: COMMITS,
  hasMore: false,
  status: [
    { path: 'a.txt', code: 'M' },
    { path: 'untracked.txt', code: '?' },
  ],
  worktrees: [{ path: '/work/demo', head: h('3'), branch: 'main' }],
  sessionCommits: [],
}

const F = '\x1f'

/** The commits as `git log -z --format=…` prints them. */
export const logOf = (commits: readonly Commit[]): string =>
  commits.map(c => [c.hash, c.parents.join(' '), c.author, c.email, String(c.time), c.subject].join(F) + '\0').join('')

/** The refs as `git for-each-ref --format=…` prints them. */
export const refsOf = (snapshot: RepoSnapshot): string =>
  snapshot.refs
    .map(ref => {
      const full = ref.kind === 'branch' ? `refs/heads/${ref.name}` : ref.kind === 'remote' ? `refs/remotes/${ref.name}` : `refs/tags/${ref.name}`
      const track = ref.track ? [ref.track[0] ? `ahead ${ref.track[0]}` : '', ref.track[1] ? `behind ${ref.track[1]}` : ''].filter(Boolean).join(', ') : ''

      return [full, ref.target, '', ref.upstream ?? '', ref.isUpstreamGone ? 'gone' : track, ''].join(F)
    })
    .join('\n') + '\n'

export const DIFF = 'diff --git a/lanes.txt b/lanes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/lanes.txt\n@@ -0,0 +1,2 @@\n+Tests du calcul des lanes\n+Calcul des lanes : octopus merge\n'

export type Answer = { exitCode: number; stdout: string; stderr?: string }
export type Script = (args: readonly string[]) => Answer | undefined

/** git answering for the demo repository, unless `script` answers first. */
export function demoGit(args: readonly string[]): Answer {
  const [command, ...rest] = args
  const line = args.join(' ')

  switch (command) {
    case 'rev-parse':
      return rest.includes('--show-toplevel')
        ? { exitCode: 0, stdout: '/work/demo\n/work/demo/.git\n/work/demo/.git\n' }
        : { exitCode: 0, stdout: `${h('3')}\n` }
    case 'symbolic-ref':
      return { exitCode: 0, stdout: 'refs/heads/main\n' }
    case 'config':
      return { exitCode: 0, stdout: 'n@e.st\n' }
    case 'for-each-ref':
      return { exitCode: 0, stdout: refsOf(SNAPSHOT) }
    case 'status':
      return { exitCode: 0, stdout: ' M a.txt\0?? untracked.txt\0' }
    case 'worktree':
      return { exitCode: 0, stdout: `worktree /work/demo\nHEAD ${h('3')}\nbranch refs/heads/main\n\n` }
    case 'log': {
      const skip = Number(/--skip=(\d+)/.exec(line)?.[1] ?? 0)
      const count = Number(/ -n(\d+)/.exec(line)?.[1] ?? 1000)

      return { exitCode: 0, stdout: logOf(COMMITS.slice(skip, skip + count)) }
    }
    case 'rev-list':
      return { exitCode: 0, stdout: '' }
    case 'diff-tree':
      return rest.includes('--name-status')
        ? { exitCode: 0, stdout: 'A\0lanes.txt\0' }
        : { exitCode: 0, stdout: '2\t0\tlanes.txt\0' }
    case 'diff':
      if (rest.includes('--numstat')) {
        return rest.includes('--no-index')
          ? { exitCode: 1, stdout: '1\t0\t\0/dev/null\0untracked.txt\0' }
          : { exitCode: 0, stdout: '1\t0\ta.txt\0' }
      }

      return { exitCode: 0, stdout: DIFF }
    default:
      return { exitCode: 1, stdout: '', stderr: `unexpected git ${line}` }
  }
}
