import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { buildDemo, demoFile, demoRun, type DemoRun, demoSteps, isDemoFile, isDemoRoot, isDemoRun, remoteOf, repoOf } from '../src/demo'
import { isAllowedWrite } from '../src/git-actions'
import { isReadOnly, READ_FLAGS } from '../src/git-commands'

const ROOT = '/tmp/ctree-demo.Ab12Cd34'
const REPO = repoOf(ROOT)

/** A git run in the demo's repository, as the build makes them. */
const inRepo = (args: string[]): DemoRun => demoRun(ROOT, { kind: 'git', where: 'repo', args })

describe('the demo’s own guard', () => {
  test('every step of the build passes it: files in the work tree, git pinned to the demo’s repositories', () => {
    for (const step of demoSteps()) {
      const ok = step.kind === 'file' ? isDemoFile(ROOT, demoFile(ROOT, step.path)) : isDemoRun(ROOT, demoRun(ROOT, step))
      const what = step.kind === 'file' ? step.path : step.args.join(' ')

      expect(`${what} → ${ok}`).toBe(`${what} → true`)
    }
  })

  test('the folder must be one mktemp made from the demo’s template', () => {
    expect(isDemoRoot(ROOT)).toBe(true)
    expect(isDemoRoot('/var/folders/9x/abc/T/ctree-demo.bPDDXeIJ')).toBe(true)

    for (const root of ['/Users/me/project', 'ctree-demo.Ab12Cd34', '/tmp/ctree-demo.', '/tmp/ctree-demo.ab', '/tmp/../Users/me/ctree-demo.Ab12Cd34', '/tmp//ctree-demo.Ab12Cd34', '/tmp/ctree-demo.Ab12Cd34/..']) {
      expect(`${root} → ${isDemoRoot(root)}`).toBe(`${root} → false`)
    }
  })

  test('a run anywhere else, or on another repository, is refused', () => {
    const run = inRepo(['add', '-A'])

    expect(isDemoRun(ROOT, run)).toBe(true)
    // The person's own repository, by its folder or by GIT_DIR.
    expect(isDemoRun(ROOT, { ...run, cwd: '/Users/me/project' })).toBe(false)
    expect(isDemoRun(ROOT, { ...run, env: { ...run.env, GIT_DIR: '/Users/me/project/.git' } })).toBe(false)
    expect(isDemoRun(ROOT, { ...run, env: { ...run.env, GIT_WORK_TREE: '/Users/me/project' } })).toBe(false)
    // Another folder than the one made, even of the same shape.
    expect(isDemoRun('/tmp/ctree-demo.Zz99Yy88', run)).toBe(false)
    expect(isDemoRun('/Users/me/project', demoRun('/Users/me/project', { kind: 'git', where: 'repo', args: ['add', '-A'] }))).toBe(false)
  })

  test('only the shapes the build uses: nothing forced, deleted, reset or sent elsewhere', () => {
    const refused = [
      ['reset', '--hard', 'HEAD~2'],
      ['push', '-q', '-u', 'origin', '+main'],
      ['push', '-q', '-u', 'origin', ':main'],
      ['push', '-q', '--force', '-u', 'origin', 'main'],
      ['push', '-q', '-u', 'origin', 'main', '--delete'],
      ['push', '-q', '-u', 'upstream', 'main'],
      ['push', '--mirror', 'origin'],
      ['remote', 'add', 'origin', 'git@github.com:someone/else.git'],
      ['remote', 'add', 'origin', '/Users/me/project'],
      ['tag', '-d', 'v0.1.0'],
      ['tag', '-a', '-f', 'v0.1.0', '-m', 'x'],
      ['branch', '-D', 'feature/cli'],
      ['stash', 'drop'],
      ['stash', 'clear'],
      ['commit', '-q', '-m', 'x', '--amend'],
      ['commit', '-q', '-m', '--amend'],
      ['switch', '-q', '--discard-changes'],
      ['switch', '-q', '-c', '-f'],
      ['merge', '-q', '--no-ff', '-m', 'x', '--strategy=ours'],
      ['clean', '-fdx'],
      ['checkout', '--', '.'],
      ['config', 'core.hooksPath', '/tmp/hooks'],
      ['-C', '/Users/me/project', 'add', '-A'],
      ['init', '-q', '--bare', '-b', 'main'],
      [],
    ]

    for (const args of refused) {
      expect(`${args.join(' ')} → ${isDemoRun(ROOT, inRepo(args))}`).toBe(`${args.join(' ')} → false`)
    }

    // The remote is made, and nothing else is run there.
    const remote = (args: string[]) => demoRun(ROOT, { kind: 'git', where: 'remote', args })

    expect(isDemoRun(ROOT, remote(['init', '-q', '--bare', '-b', 'main']))).toBe(true)
    expect(isDemoRun(ROOT, remote(['add', '-A']))).toBe(false)
  })

  test('files only inside the work tree, never in .git, never by ..', () => {
    expect(isDemoFile(ROOT, `${REPO}/src/greet.js`)).toBe(true)

    for (const path of [`${REPO}/.git/hooks/pre-commit`, `${REPO}/../escape.txt`, `${REPO}/src/../../x`, `${ROOT}/origin.git/config`, '/Users/me/project/a.txt', `${REPO}/`, `${REPO}/a b.txt`]) {
      expect(`${path} → ${isDemoFile(ROOT, path)}`).toBe(`${path} → false`)
    }
  })

  test('it is a guard apart: isAllowedWrite admits none of the demo’s writes', () => {
    for (const step of demoSteps()) {
      if (step.kind === 'git') expect(`${step.args.join(' ')} → ${isAllowedWrite(demoRun(ROOT, step).args)}`).toBe(`${step.args.join(' ')} → false`)
    }
  })
})

describe('building the demo', () => {
  /** A runner that keeps what it was asked to run; git fails on the command `failing` names. */
  const recorder = (failing?: string) => {
    const runs: DemoRun[] = []
    const files: string[] = []

    return {
      runs,
      files,
      runner: {
        git: async (run: DemoRun) => {
          runs.push(run)

          return run.args.join(' ') === failing ? { code: 1, stderr: 'fatal: no\nmore' } : { code: 0, stderr: '' }
        },
        file: async (path: string) => {
          files.push(path)
        },
      },
    }
  }

  test('the same steps every time: fixed authors and dates, the remote beside the repository', async () => {
    const one = recorder()
    const two = recorder()

    expect(await buildDemo(ROOT, one.runner)).toEqual({ ok: true })
    await buildDemo(ROOT, two.runner)

    expect(two.runs).toEqual(one.runs)
    expect(one.runs.every(run => run.env.GIT_AUTHOR_DATE && run.env.GIT_COMMITTER_DATE === run.env.GIT_AUTHOR_DATE)).toBe(true)
    expect(one.runs.every(run => run.env.GIT_CONFIG_GLOBAL === '/dev/null' && run.env.GIT_CONFIG_NOSYSTEM === '1')).toBe(true)
    expect(one.runs.find(run => run.args[0] === 'remote')?.args).toEqual(['remote', 'add', 'origin', remoteOf(ROOT)])
    expect(new Set(one.runs.map(run => run.env.GIT_AUTHOR_NAME))).toEqual(new Set(['Ada Lovelace', 'Grace Hopper']))
    expect(one.files.every(path => path.startsWith(`${REPO}/`))).toBe(true)
  })

  test('history: two tags, a merge, a pushed branch, one never pushed, two commits ahead, a stash, changes left', () => {
    const steps = demoSteps()
    const git = steps.flatMap(step => (step.kind === 'git' ? [step.args.join(' ')] : []))

    expect(git.filter(line => line.startsWith('tag -a'))).toEqual(['tag -a v0.1.0 -m v0.1.0', 'tag -a v0.2.0 -m v0.2.0'])
    expect(git.filter(line => line.startsWith('merge'))).toHaveLength(1)
    expect(git.filter(line => line.startsWith('push'))).toEqual(['push -q --follow-tags -u origin main', 'push -q -u origin feature/lang'])
    expect(git.filter(line => line.startsWith('stash'))).toEqual(['stash push -q -m README badges'])

    // Past the last push: two commits on main, then files written and not committed.
    const lastPush = git.lastIndexOf('push -q -u origin feature/lang')
    const commitsAfter = git.slice(lastPush).filter(line => line.startsWith('commit'))

    expect(commitsAfter).toEqual(['commit -q -m Sketch a command line', 'commit -q -m Add farewell()', 'commit -q -m Test farewell()'])
    expect(steps.at(-1)).toMatchObject({ kind: 'file', path: 'notes.txt' })
  })

  test('the first git failure stops the build, saying which command', async () => {
    const { runs, runner } = recorder("merge -q --no-ff -m Merge branch 'feature/lang' feature/lang")
    const result = await buildDemo(ROOT, runner)

    expect(result).toEqual({ ok: false, step: "git merge -q --no-ff -m Merge branch 'feature/lang' feature/lang", error: 'fatal: no' })
    expect(runs.at(-1)?.args[0]).toBe('merge')
  })
})

describe('/ctree demo', () => {
  /** A session whose mktemp makes `made`, holding `entries`; every process and file write kept. */
  function world(on: On, made: string, entries: string[] = []) {
    const runs: { argv: readonly string[]; cwd: string | undefined; env: Readonly<Record<string, string>> }[] = []
    const written: string[] = []

    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work/demo' }))
    on('session.turns', () => ({ value: 1 }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('process.run', ($, e) => {
      runs.push({ argv: e.argv, cwd: e.init?.cwd, env: e.init?.env ?? {} })

      const stdout = e.argv[0] === 'mktemp' ? `${made}\n` : ''

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.list', () => ({ value: entries.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
    on('fs.write', ($, e) => {
      written.push(e.path)

      return { value: undefined }
    })
    mock.env(on, { TMPDIR: '/tmp/' })
    mock.store(on, {})
    mock.session(on)

    return { runs, written }
  }

  const run = { command: 'ctree', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

  test('builds the repository in the folder mktemp made, writes nowhere else, then says how to try the guard', { options: { language: 'en' } }, async ($, on) => {
    const w = world(on, ROOT)

    await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

    const result = await $.command.run(run)
    const text = 'text' in result ? result.text ?? '' : ''

    expect(w.runs.find(one => one.argv[0] === 'mktemp')?.argv).toEqual(['mktemp', '-d', '/tmp/ctree-demo.XXXXXXXX'])
    expect(text).toContain(`Demo repository ready in ${REPO}`)
    expect(text).toContain(`cd '${REPO}' && claude`)
    expect(text).toContain('git reset --hard HEAD~2')

    const gits = w.runs.filter(one => one.argv[0] === 'git')
    const demo = gits.filter(one => one.env.GIT_DIR !== undefined)

    expect(demo.length).toBe(demoSteps().filter(step => step.kind === 'git').length)

    for (const one of demo) {
      const args = one.argv.slice(1 + READ_FLAGS.length)
      const env = Object.fromEntries(Object.entries(one.env).filter(([key]) => key.startsWith('GIT_') && !['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].includes(key)))

      expect(isDemoRun(ROOT, { args, cwd: one.cwd ?? '', env })).toBe(true)
    }

    // Every other git run is a read; every file written is in the demo's work tree.
    expect(gits.filter(one => one.env.GIT_DIR === undefined).every(one => isReadOnly(one.argv.slice(1 + READ_FLAGS.length)))).toBe(true)
    expect(w.written.length).toBeGreaterThan(5)
    expect(w.written.every(path => path.startsWith(`${REPO}/`))).toBe(true)
  })

  for (const [name, made, entries] of [
    ['a folder not empty', ROOT, ['someone.txt']],
    ['a folder not of the demo’s template', '/Users/me/project', []],
  ] as const) {
    test(`refuses ${name}: nothing written, no git run on it`, { options: { language: 'en' } }, async ($, on) => {
      const w = world(on, made, [...entries])

      await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

      const result = await $.command.run(run)

      expect('text' in result ? result.text : '').toContain('The demo needs a new temporary folder')
      expect(w.written).toEqual([])
      expect(w.runs.some(one => one.env.GIT_DIR !== undefined)).toBe(false)
    })
  }

  test('an unknown argument says what /ctree takes', { options: { language: 'fr' } }, async ($, on) => {
    world(on, ROOT)
    await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

    const result = await $.command.run({ ...run, args: 'démo' })

    expect('text' in result ? result.text : '').toBe('Argument « démo » inconnu. /ctree ouvre le panneau ; /ctree demo crée un dépôt de démonstration pour l’essayer.')
  })
})
