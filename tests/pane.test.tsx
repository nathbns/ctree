import type { Args, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { isAllowedWrite } from '../src/git-actions'
import { isReadOnly, READ_FLAGS } from '../src/git-commands'
import { type Answer, demoGit, h, linearSnapshot, logOf, nth, type Script } from './fixtures'

/** The pane docked beside a fullscreen transcript: 88 columns, 16 rows. */
const PANE = {
  plugin: 'ctree',
  component: 'Pane',
  requestId: 'ctree',
  props: {
    title: 'Git',
    isFocused: true,
    bodyColumns: 89,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 16 },
    view: {},
  },
} as const

const OPEN = {
  command: 'ctree',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const

/**
 * A session in /work/demo whose git answers from `script`, then the demo.
 * Keeps every git run (its arguments after the flags), the writes apart,
 * what was put in the prompt, the panes opened, the rows appended.
 */
function world(on: On, script: Script = () => undefined) {
  const runs: string[][] = []
  const writes: string[][] = []
  const filled: string[] = []
  const opened: Args<'ui.open'>[] = []
  const focused: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 26, 12) })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.turns', () => ({ value: 3 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', ($, e) => {
    focused.push(e.element ?? '')

    return {}
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('process.run', ($, e) => {
    const [git, ...flagsAndArgs] = e.argv
    const args = flagsAndArgs.slice(READ_FLAGS.length)

    expect(git).toBe('git')
    expect(flagsAndArgs.slice(0, READ_FLAGS.length)).toEqual([...READ_FLAGS])
    expect(`${args.join(' ')} → ${isReadOnly(args) || isAllowedWrite(args)}`).toBe(`${args.join(' ')} → true`)
    runs.push(args)

    if (!isReadOnly(args)) {
      writes.push(args)

      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    const answer = script(args) ?? demoGit(args)

    return { value: { stderr: '', ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })

  mock.env(on, {})

  const session = mock.session(on)

  return { runs, writes, filled, opened, focused, clock, session }
}

async function openPane($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await $.command.run(OPEN)
  await w.clock.settle()
}

const rowTexts = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined; text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).filter(button => !button.key?.startsWith('key-')).map(button => button.text)

describe('the pane', () => {
  test('/ctree opens a focused pane as wide as a dock may be, closing on Escape', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    // 45% of the 200-column terminal the command saw.
    expect(w.opened[0]).toMatchObject({ id: 'ctree', title: 'ctree', focus: true, closeOnEscape: true, columns: 90 })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the graph, its labels and the pinned uncommitted row, on ${surface}`, async ($, on) => {
      const w = world(on)

      await openPane($, w)

      const ui = await $.ui.mount({ ...PANE, surface })
      const rows = await rowTexts(ui)

      expect(rows[0]).toContain('◌')
      expect(rows[0]).toContain('Modifications non commitées (2)')
      expect(rows.find(row => row.includes('Merge branch'))).toContain('◉─┼─╮')
      expect(rows.find(row => row.includes('Merge branch'))).toContain('main ⇄ origin')
      expect(rows.find(row => row.includes('Parsing de git log'))).toContain('◇ v0.1.0')
      expect((await ui.find({ type: 'Text', text: /demo · ⎇ main/ }))?.text).toContain('✓ origin/main')
      await ui.unmount()
    })
  }

  test('Enter on a commit unfolds its files, Enter on a file shows its diff, q goes back', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: `c:${h('3')}` })
    await w.clock.settle()

    const file = await ui.find({ key: `f:${h('3')}:0` })

    expect(file?.text).toContain('A lanes.txt')
    expect(file?.text).toContain('+2')
    expect(w.runs.some(args => args[0] === 'diff-tree' && args.includes(h('6')) && args.includes(h('3')))).toBe(true)

    await ui.press({ key: `f:${h('3')}:0` })
    await w.clock.settle()

    const code = await ui.find({ type: 'Code' })

    expect(code?.props).toMatchObject({ format: 'diff', source: expect.stringContaining('@@ -0,0 +1,2 @@') })

    await ui.press({ key: 'key-q' })

    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ key: `f:${h('3')}:0` })).toBeDefined()
    await ui.unmount()
  })

  test('j and k move the selection', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const selected = async () => (await rowTexts(ui)).find(row => row.startsWith('❯'))

    // HEAD's commit is selected first.
    expect(await selected()).toContain('Merge branch')

    await ui.press({ key: 'key-j' })
    expect(await selected()).toContain('Calcul des lanes')

    await ui.press({ key: 'key-k' })
    await ui.press({ key: 'key-k' })
    expect(await selected()).toContain('Navigation j/k')
    await ui.unmount()
  })

  test('e puts a question about the selected commit in the prompt, without sending it', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-e' })

    expect(w.filled).toHaveLength(1)
    expect(w.filled[0]).toContain('3333333')
    expect(w.filled[0]).toContain("Merge branch 'feature/lanes'")
    expect(await ui.find({ type: 'Text', text: /Question prête/ })).toBeDefined()
    await ui.unmount()
  })

  test('a git command Claude runs reloads the graph; an edit reloads only the status', async ($, on) => {
    const w = world(on)

    on('tool.call', () => ({ result: {} }))
    await openPane($, w)

    const logs = () => w.runs.filter(args => args[0] === 'log').length
    const statuses = () => w.runs.filter(args => args[0] === 'status').length
    const before = { logs: logs(), statuses: statuses() }

    await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
    await w.clock.advance(1000)

    expect(logs()).toBe(before.logs + 1)

    await $.tool.call({ tool: 'Edit', file_path: '/work/demo/a.txt', old_string: 'a', new_string: 'b' })
    await w.clock.advance(1000)

    expect(logs()).toBe(before.logs + 1)
    expect(statuses()).toBe(before.statuses + 2)
  })

  test('a burst of git commands reloads once', async ($, on) => {
    const w = world(on)

    on('tool.call', () => ({ result: {} }))
    await openPane($, w)

    const logs = () => w.runs.filter(args => args[0] === 'log').length
    const before = logs()

    await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m one' })
    await $.tool.call({ tool: 'Bash', command: 'git tag v1' })
    await w.clock.advance(1000)

    expect(logs()).toBe(before + 1)
  })

  test('r reloads on demand', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const before = w.runs.filter(args => args[0] === 'log').length

    await ui.press({ key: 'key-r' })

    expect(w.runs.filter(args => args[0] === 'log').length).toBe(before + 1)
    await ui.unmount()
  })
})

describe('the changes (V2)', () => {
  const appendedText = (w: ReturnType<typeof world>) =>
    w.session.appended().map(row => JSON.stringify(row.message.content)).join('\n')

  test('c shows the command in place of the keys; n runs nothing, y switches and tells Claude', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-k' })
    await ui.press({ key: 'key-k' })
    await ui.press({ key: 'key-c' })

    expect(await ui.find({ type: 'Text', text: /git switch feature\/ui/ })).toBeDefined()
    expect(await ui.find({ key: 'key-j' })).toBeUndefined()

    await ui.press({ key: 'act-n' })

    expect(w.writes).toEqual([])
    expect(await ui.find({ key: 'key-j' })).toBeDefined()

    await ui.press({ key: 'key-c' })
    await ui.press({ key: 'act-y' })
    await w.clock.settle()

    expect(w.writes).toEqual([['switch', 'feature/ui']])
    expect(appendedText(w)).toContain('passée sur la branche feature/ui')
    expect(await ui.find({ type: 'Text', text: /✓ Sur feature\/ui/ })).toBeDefined()
    await ui.unmount()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`t opens a form with the next version, refuses a taken name, then tags, on ${surface}`, async ($, on) => {
      const w = world(on)

      await openPane($, w)

      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.press({ key: 'key-t' })

      expect((await ui.find({ key: 'tag-name' }))?.props.value).toBe('v0.3.0')

      await ui.input({ key: 'tag-name', text: 'v0.2.0' })

      expect(await ui.find({ type: 'Text', text: /le tag v0.2.0 existe déjà/ })).toBeDefined()
      expect(w.writes).toEqual([])

      await ui.input({ key: 'tag-name', text: 'v0.3.0' })

      expect(await ui.find({ type: 'Text', text: /git tag -a v0.3.0 -m v0.3.0 3333333/ })).toBeDefined()

      await ui.press({ key: 'act-y' })
      await w.clock.settle()

      expect(w.writes).toEqual([['tag', '-a', 'v0.3.0', '-m', 'v0.3.0', h('3')]])
      await ui.unmount()
    })
  }

  test('p lists what would leave before pushing, then pushes on y', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-p' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: /git push --follow-tags origin main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 tag : v0.1.0/ })).toBeDefined()
    expect(w.writes).toEqual([])

    await ui.press({ key: 'act-y' })
    await w.clock.settle()

    expect(w.writes).toEqual([['push', '--follow-tags', 'origin', 'main']])
    expect(appendedText(w)).toContain('a poussé main vers origin/main')
    await ui.unmount()
  })

  test('a push that would need force is blocked, never sent', async ($, on) => {
    const w = world(on, args =>
      args[0] === 'for-each-ref'
        ? { exitCode: 0, stdout: `refs/heads/main\x1f${h('3')}\x1f\x1forigin/main\x1fahead 1, behind 2\x1f\n` }
        : undefined,
    )

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-p' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: /pas de push forcé/ })).toBeDefined()
    expect(await ui.find({ key: 'act-y' })).toBeUndefined()
    expect(w.writes).toEqual([])
    await ui.unmount()
  })
})

describe('seeing the whole graph (V3)', () => {
  test('v folds a long straight history into a few rows; f focuses on main', async ($, on) => {
    const all = linearSnapshot(250).commits
    const w = world(on, args => {
      const line = args.join(' ')

      if (args[0] === 'status') return { exitCode: 0, stdout: '' }
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { exitCode: 0, stdout: `${nth(0)}\n` }
      if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: `refs/heads/main\x1f${nth(0)}\x1f\x1f\x1f\x1f\n` }
      if (args[0] !== 'log') return undefined

      const skip = Number(/--skip=(\d+)/.exec(line)?.[1] ?? 0)
      const count = Number(/ -n(\d+)/.exec(line)?.[1] ?? 1000)

      return { exitCode: 0, stdout: logOf(all.slice(skip, skip + count)) }
    })

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await rowTexts(ui)).length).toBeGreaterThan(5)

    await ui.press({ key: 'key-v' })
    await w.clock.settle()

    // The rest loads by itself: main, the 248 commits between as one fold, the root.
    const rows = await rowTexts(ui)

    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('▸ 248 commits · Léa, Nathan')
    expect(rows[2]).toContain('commit 249')
    expect(await ui.find({ type: 'Text', text: /▤ vue d’ensemble/ })).toBeDefined()

    await ui.press({ key: 'key-f' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: /◎ main/ })).toBeDefined()
    expect(w.runs.some(args => args.includes('refs/heads/main'))).toBe(true)
    await ui.unmount()
  })
})

describe('the guard and the journal (V3, lot C)', () => {
  /** The person's answer in Claude Code's question dialog, and the questions asked. */
  const answering = (on: On, answer: string) => {
    const asked: string[] = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const question = e.questions[0]?.question ?? ''

      asked.push(question)

      return { result: { questions: e.questions, answers: { [question]: answer } } }
    })

    return asked
  }

  /** The demo's refs as a state the Bash stub can move, as a git command would. */
  const movable = () => {
    const refs: Record<string, string> = { 'refs/heads/main': h('3'), 'refs/heads/feature/ui': h('1'), 'refs/remotes/origin/main': h('3') }
    const script: Script = args =>
      args[0] === 'for-each-ref' && args.includes('--format=%(refname)%1f%(objectname)')
        ? { exitCode: 0, stdout: Object.entries(refs).map(([ref, hash]) => `${ref}\x1f${hash}`).join('\n') + '\n' }
        : args[0] === 'rev-parse' && args.includes('--verify') && !args.some(arg => arg.includes('~'))
          ? { exitCode: 0, stdout: `${refs['refs/heads/main']}\n` }
          : undefined

    return { refs, script }
  }

  test('Claude’s reset --hard waits for the person; refused, it never runs and Claude reads why', async ($, on) => {
    const w = world(on)
    const asked = answering(on, 'Refuser')
    const ran: string[] = []

    on('tool.call', { tool: 'Bash' }, ($, e) => {
      ran.push(e.command)

      return { result: {} }
    })
    await openPane($, w)

    const result = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })

    expect(asked[0]).toContain('Claude veut lancer « git reset --hard HEAD~1 »')
    expect(asked[0]).toContain('1 fichier modifié perdu : a.txt')
    expect(ran).toEqual([])
    expect(JSON.stringify(result)).toContain('la personne a refusé')
  })

  test('let through, it runs and goes in the journal; l lists it, Enter undoes it once confirmed', async ($, on) => {
    const { refs, script } = movable()
    const w = world(on, script)

    answering(on, 'Laisser passer')
    on('tool.call', { tool: 'Bash' }, () => {
      // What the reset does to the refs.
      refs['refs/heads/main'] = h('6')

      return { result: {} }
    })
    await openPane($, w)
    await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-l' })

    const entry = (await ui.findAll({ type: 'Button' })).find(button => button.key?.startsWith('journal-'))

    expect(entry?.text).toContain('tour 3 · git reset --hard HEAD~1')
    expect(await ui.find({ type: 'Text', text: /main 3333333 → 6666666/ })).toBeDefined()

    await ui.press({ key: entry?.key ?? '' })

    // One way back: the band shows it, and nothing runs before y.
    expect(await ui.find({ type: 'Text', text: /git reset --keep 3333333/ })).toBeDefined()
    expect(w.writes.filter(args => args[0] !== 'stash')).toEqual([])

    await ui.press({ key: 'act-y' })
    await w.clock.settle()

    expect(w.writes.filter(args => args[0] !== 'stash')).toEqual([['reset', '--keep', h('3')]])
    await ui.unmount()
  })

  test('a command that loses nothing is never held', async ($, on) => {
    const w = world(on)
    const asked = answering(on, 'Refuser')
    const ran: string[] = []

    on('tool.call', { tool: 'Bash' }, ($, e) => {
      ran.push(e.command)

      return { result: {} }
    })
    await openPane($, w)
    await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "x"' })

    expect(asked).toEqual([])
    expect(ran).toEqual(['git add -A && git commit -m "x"'])
  })

  test('s shows what the session changed', async ($, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-s' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: /✦ Cette session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Branches et tags · 0/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the guard can be turned off', () => {
  test('with guard: false, Claude’s reset --hard runs without a question', { options: { guard: false } }, async ($, on) => {
    const w = world(on)
    const ran: string[] = []

    on('tool.call', { tool: 'Bash' }, ($, e) => {
      ran.push(e.command)

      return { result: {} }
    })
    await openPane($, w)
    await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })

    expect(ran).toEqual(['git reset --hard HEAD~1'])
  })
})

describe('the edge cases', () => {
  test('outside a repository the pane says so', async ($, on) => {
    const w = world(on, args =>
      args[0] === 'rev-parse' || args[0] === 'for-each-ref'
        ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : undefined,
    )

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /Pas de dépôt git ici/ })).toBeDefined()
    expect(w.runs.some(args => args[0] === 'log')).toBe(false)
    await ui.unmount()
  })

  test('an empty repository shows its branch, no commit, and the files waiting', async ($, on) => {
    const w = world(on, args => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { exitCode: 1, stdout: '' }
      if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: '' }
      if (args[0] === 'status') return { exitCode: 0, stdout: '?? README.md\0' }

      return undefined
    })

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /demo · ⎇ main/ }))?.text).toContain('aucun commit')
    expect(await ui.find({ type: 'Text', text: /Aucun commit pour l’instant/ })).toBeDefined()
    expect((await rowTexts(ui))[0]).toContain('Modifications non commitées (1)')
    expect(w.runs.some(args => args[0] === 'log')).toBe(false)
    await ui.unmount()
  })

  test('a detached HEAD is labelled on its commit and in the header', async ($, on) => {
    const w = world(on, args => (args[0] === 'symbolic-ref' ? { exitCode: 1, stdout: '' } : undefined))

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /HEAD détachée @ 3333333/ }))).toBeDefined()
    expect((await rowTexts(ui)).find(row => row.includes('Merge branch'))).toContain('HEAD détachée')
    await ui.unmount()
  })

  test('a linked worktree says so in the header', async ($, on) => {
    const w = world(on, args =>
      args[0] === 'rev-parse' && args.includes('--show-toplevel')
        ? { exitCode: 0, stdout: '/work/demo-wt\n/work/demo/.git/worktrees/demo-wt\n/work/demo/.git\n' }
        : undefined,
    )

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /demo-wt · ⎇ main/ }))?.text).toContain('worktree secondaire')
    await ui.unmount()
  })

  test('a long history loads 100 commits, then the next page when the selection nears the end', async ($, on) => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      hash: i.toString(16).padStart(40, '0'),
      parents: i < 249 ? [(i + 1).toString(16).padStart(40, '0')] : [],
      author: 'A',
      email: 'a@e.st',
      time: 1_790_000_000 - i * 60,
      subject: `commit ${i}`,
    }))
    const w = world(on, args => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '' }
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { exitCode: 0, stdout: `${many[0]?.hash}\n` }
      if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: `refs/heads/main\x1f${many[0]?.hash}\x1f\x1f\x1f\x1f\n` }
      if (args[0] !== 'log') return undefined

      const line = args.join(' ')
      const skip = Number(/--skip=(\d+)/.exec(line)?.[1] ?? 0)
      const count = Number(/ -n(\d+)/.exec(line)?.[1] ?? 1000)

      return { exitCode: 0, stdout: logOf(many.slice(skip, skip + count)) }
    })

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const logs = () => w.runs.filter(args => args[0] === 'log')

    expect(logs()).toHaveLength(1)
    expect(logs()[0]).toContain('-n101')

    for (let i = 0; i < 90; i += 1) {
      await ui.press({ key: 'key-j' })
    }

    await w.clock.settle()

    expect(logs()).toHaveLength(2)
    expect(logs()[1]).toContain('--skip=100')
    expect(await ui.find({ key: `c:${many[150]?.hash}` })).toBeUndefined()

    for (let i = 0; i < 70; i += 1) {
      await ui.press({ key: 'key-j' })
    }

    expect((await rowTexts(ui)).find(row => row.startsWith('❯'))).toContain('commit 160')
    await ui.unmount()
  })
})
