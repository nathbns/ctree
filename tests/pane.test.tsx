import type { Args, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { isAllowedWrite } from '../src/git-actions'
import { isReadOnly, READ_FLAGS } from '../src/git-commands'
import { LANGUAGES } from '../src/i18n'
import { type Answer, COMMITS, demoGit, h, linearSnapshot, logOf, nth, type Say, type Script } from './fixtures'

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
function world(on: On, script: Script = () => undefined, stored: Record<string, unknown> = {}, env: Record<string, string> = {}) {
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

      // The guard's copy of the changes a command throws away.
      const stdout = args[0] === 'stash' && args[1] === 'create' ? `${h('5')}\n` : ''

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    const answer = script(args) ?? demoGit(args)

    return { value: { stderr: '', ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })

  mock.env(on, env)
  mock.store(on, stored)

  const session = mock.session(on)

  return { runs, writes, filled, opened, focused, clock, session }
}

async function openPane($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await $.command.run(OPEN)
  await w.clock.settle()
}

/**
 * A pane test run once per language, set by the plugin's `language` option:
 * `say(en, fr)` picks what it expects.
 */
function inBoth(name: string, body: (say: Say, $: Engine, on: On) => Promise<void>): void {
  for (const language of LANGUAGES) {
    test(`${name} (${language})`, { options: { language } }, async ($, on) => body((en, fr) => (language === 'fr' ? fr : en), $, on))
  }
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
    inBoth(`the graph, its labels and the pinned uncommitted row, on ${surface}`, async (say, $, on) => {
      const w = world(on)

      await openPane($, w)

      const ui = await $.ui.mount({ ...PANE, surface })
      const rows = await rowTexts(ui)

      expect(rows[0]).toContain('◌')
      expect(rows[0]).toContain(say('Uncommitted changes (2)', 'Modifications non commitées (2)'))
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

  inBoth('e puts a question about the selected commit in the prompt, without sending it', async (say, $, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-e' })

    expect(w.filled).toHaveLength(1)
    expect(w.filled[0]).toContain('3333333')
    expect(w.filled[0]).toContain("Merge branch 'feature/lanes'")
    expect(await ui.find({ type: 'Text', text: say(/Question ready/, /Question prête/) })).toBeDefined()
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

  inBoth('c shows the command in place of the keys; n runs nothing, y switches and tells Claude in English', async (say, $, on) => {
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
    expect(appendedText(w)).toContain('the person switched to branch feature/ui')
    expect(await ui.find({ type: 'Text', text: say(/✓ On feature\/ui/, /✓ Sur feature\/ui/) })).toBeDefined()
    await ui.unmount()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    inBoth(`t opens a form with the next version, refuses a taken name, then tags, on ${surface}`, async (say, $, on) => {
      const w = world(on)

      await openPane($, w)

      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.press({ key: 'key-t' })

      expect((await ui.find({ key: 'tag-name' }))?.props.value).toBe('v0.3.0')

      await ui.input({ key: 'tag-name', text: 'v0.2.0' })

      expect(await ui.find({ type: 'Text', text: say(/tag v0.2.0 already exists/, /le tag v0.2.0 existe déjà/) })).toBeDefined()
      expect(w.writes).toEqual([])

      await ui.input({ key: 'tag-name', text: 'v0.3.0' })

      expect(await ui.find({ type: 'Text', text: /git tag -a v0.3.0 -m v0.3.0 3333333/ })).toBeDefined()

      await ui.press({ key: 'act-y' })
      await w.clock.settle()

      expect(w.writes).toEqual([['tag', '-a', 'v0.3.0', '-m', 'v0.3.0', h('3')]])
      await ui.unmount()
    })
  }

  inBoth('p lists what would leave before pushing, then pushes on y', async (say, $, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-p' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: /git push --follow-tags origin main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: say(/1 tag: v0.1.0/, /1 tag : v0.1.0/) })).toBeDefined()
    expect(w.writes).toEqual([])

    await ui.press({ key: 'act-y' })
    await w.clock.settle()

    expect(w.writes).toEqual([['push', '--follow-tags', 'origin', 'main']])
    expect(appendedText(w)).toContain('the person pushed main to origin/main')
    await ui.unmount()
  })

  inBoth('a push that would need force is blocked, never sent', async (say, $, on) => {
    const w = world(on, args =>
      args[0] === 'for-each-ref'
        ? { exitCode: 0, stdout: `refs/heads/main\x1f${h('3')}\x1f\x1forigin/main\x1fahead 1, behind 2\x1f\n` }
        : undefined,
    )

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-p' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: say(/no force push/, /pas de push forcé/) })).toBeDefined()
    expect(await ui.find({ key: 'act-y' })).toBeUndefined()
    expect(w.writes).toEqual([])
    await ui.unmount()
  })
})

describe('seeing the whole graph (V3)', () => {
  inBoth('v folds a long straight history into a few rows; f focuses on main', async (say, $, on) => {
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
    expect(await ui.find({ type: 'Text', text: say(/▤ overview/, /▤ vue d’ensemble/) })).toBeDefined()

    await ui.press({ key: 'key-f' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: /◎ main/ })).toBeDefined()
    expect(w.runs.some(args => args.includes('refs/heads/main'))).toBe(true)
    await ui.unmount()
  })
})

describe('the full-width band (z)', () => {
  /** The band above the prompt of a 200-column fullscreen terminal. */
  const BAND = {
    plugin: 'ctree',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 195, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  } as const

  /** What Claude Code draws in the band when ctree does not. */
  const beneath = (on: On) =>
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      // No JSX here: `h` is the fixtures' hash helper in this file.
      return Text({ children: ['engine band'] })
    })

  inBoth('z moves ctree from the pane to the whole width above the prompt, and back', async (say, $, on) => {
    const w = world(on)

    beneath(on)
    await openPane($, w)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const before = await $.ui.mount({ ...BAND, surface: 'terminal' })

    // Under the pane, the band is left to Claude Code.
    expect(await before.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await before.unmount()

    await pane.press({ key: 'key-z' })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const merge = (await rowTexts(band)).find(row => row.includes('Merge branch'))

    // 195 columns: the whole message, the author, the date and the hash.
    expect(merge).toContain("Merge branch 'feature/lanes'")
    expect(merge).toContain('Nathan')
    expect(merge).toContain('3333333')
    expect((await band.find({ key: 'key-z' }))?.props.label).toBe(say('pane', 'panneau'))

    await band.press({ key: 'key-z' })

    expect(w.opened).toHaveLength(2)
    expect(await band.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    await band.unmount()
    await pane.unmount()
  })

  test('the band, once chosen, is where /ctree opens next time', async ($, on) => {
    const w = world(on, () => undefined, { placement: 'band' })

    beneath(on)
    await openPane($, w)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(w.opened).toHaveLength(0)
    expect((await rowTexts(band)).some(row => row.includes('Merge branch'))).toBe(true)
    await band.unmount()
  })
})

describe('the guard and the journal (V3, lot C)', () => {
  /** The person's answer in Claude Code's question dialog (its first option, or its second), and the questions asked. */
  const answering = (on: On, answer: 'run' | 'refuse') => {
    const asked: string[] = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const question = e.questions[0]?.question ?? ''
      const label = e.questions[0]?.options[answer === 'run' ? 0 : 1]?.label ?? ''

      asked.push(question)

      return { result: { questions: e.questions, answers: { [question]: label } } }
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

  inBoth('Claude’s reset --hard waits for the person; refused, it never runs and Claude reads why, in English', async (say, $, on) => {
    const w = world(on)
    const asked = answering(on, 'refuse')
    const ran: string[] = []

    on('tool.call', { tool: 'Bash' }, ($, e) => {
      ran.push(e.command)

      return { result: {} }
    })
    await openPane($, w)

    const result = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })

    expect(asked[0]).toBe(say(
      'Claude wants to run "git reset --hard HEAD~1". 1 changed file lost: a.txt. Let it run?',
      'Claude veut lancer « git reset --hard HEAD~1 ». 1 fichier modifié perdu : a.txt. Laisser passer ?',
    ))
    expect(ran).toEqual([])
    expect(JSON.stringify(result)).toContain('the person refused')
  })

  inBoth('let through, it runs and goes in the journal; l lists it, Enter undoes it once confirmed', async (say, $, on) => {
    const { refs, script } = movable()
    const w = world(on, script)

    answering(on, 'run')
    on('tool.call', { tool: 'Bash' }, () => {
      // What the reset does to the refs.
      refs['refs/heads/main'] = h('6')

      return { result: {} }
    })
    await openPane($, w)
    await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-l' })

    const buttons = await ui.findAll({ type: 'Button' })
    const entry = buttons.find(button => button.key?.startsWith('journal-'))

    // By turn: the turn's header, then its commands.
    expect(buttons.find(button => button.key?.startsWith('turn-'))?.text).toContain(say('▸ Turn 3', '▸ Tour 3'))
    expect(entry?.text).toContain('git reset --hard HEAD~1')
    expect(await ui.find({ type: 'Text', text: /main 3333333 → 6666666/ })).toBeDefined()

    await ui.press({ key: entry?.key ?? '' })

    // Two ways back, each by every command it runs (the changed file was saved first); nothing runs before a choice.
    expect((await ui.find({ key: 'act-1' }))?.props.label).toBe('git reset --keep 3333333')
    expect((await ui.find({ key: 'act-2' }))?.props.label).toBe('git reset --keep 3333333 && git stash apply 5555555')
    expect(w.writes.filter(args => args[0] !== 'stash')).toEqual([])

    await ui.press({ key: 'act-1' })
    await w.clock.settle()

    expect(w.writes.filter(args => args[0] !== 'stash')).toEqual([['reset', '--keep', h('3')]])
    await ui.unmount()
  })

  inBoth('the journal by turn: r on a turn shows the rewind with every command; y runs them', async (say, $, on) => {
    const { refs, script } = movable()
    const w = world(on, script)

    on('tool.call', { tool: 'Bash' }, ($, e) => {
      // What the command does to the refs.
      if (e.command.startsWith('git commit')) refs['refs/heads/main'] = h('9')
      if (e.command.startsWith('git branch')) refs['refs/heads/spike'] = h('9')

      return { result: {} }
    })
    await openPane($, w)
    await $.tool.call({ tool: 'Bash', command: 'git commit -am "x"' })
    await $.tool.call({ tool: 'Bash', command: 'git branch spike' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-l' })

    const turns = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('turn-'))

    // One turn (the session's third), its two commands under it.
    expect(turns.map(button => button.text)).toEqual([say('▸ Turn 3', '▸ Tour 3')])
    expect((await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('journal-'))).toHaveLength(2)

    await ui.press({ key: 'key-r' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: say(/⟲ Rewind git to before turn 3/, /⟲ Rembobiner git avant le tour 3/) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /git reset --keep 3333333/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /git update-ref -d refs\/heads\/spike 9999999/ })).toBeDefined()
    expect(w.writes.filter(args => args[0] !== 'stash')).toEqual([])

    await ui.press({ key: 'act-y' })
    await w.clock.settle()

    expect(w.writes.filter(args => args[0] !== 'stash')).toEqual([['reset', '--keep', h('3')], ['update-ref', '-d', 'refs/heads/spike', h('9')]])
    expect(JSON.stringify(w.session.appended().at(-1)?.message.content)).toContain('the person rewound git to before turn 3')
    await ui.unmount()
  })

  test('a command that loses nothing is never held', async ($, on) => {
    const w = world(on)
    const asked = answering(on, 'refuse')
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

  inBoth('s shows what the session changed', async (say, $, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-s' })
    await w.clock.settle()

    expect(await ui.find({ type: 'Text', text: say(/✦ This session/, /✦ Cette session/) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: say(/Branches and tags · 0/, /Branches et tags · 0/) })).toBeDefined()
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
  inBoth('outside a repository the pane says so', async (say, $, on) => {
    const w = world(on, args =>
      args[0] === 'rev-parse' || args[0] === 'for-each-ref'
        ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : undefined,
    )

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: say(/No git repository here/, /Pas de dépôt git ici/) })).toBeDefined()
    expect(w.runs.some(args => args[0] === 'log')).toBe(false)
    await ui.unmount()
  })

  inBoth('an empty repository shows its branch, no commit, and the files waiting', async (say, $, on) => {
    const w = world(on, args => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { exitCode: 1, stdout: '' }
      if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: '' }
      if (args[0] === 'status') return { exitCode: 0, stdout: '?? README.md\0' }

      return undefined
    })

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /demo · ⎇ main/ }))?.text).toContain(say('no commits yet', 'aucun commit'))
    expect(await ui.find({ type: 'Text', text: say(/No commits yet\./, /Aucun commit pour l’instant/) })).toBeDefined()
    expect((await rowTexts(ui))[0]).toContain(say('Uncommitted changes (1)', 'Modifications non commitées (1)'))
    expect(w.runs.some(args => args[0] === 'log')).toBe(false)
    await ui.unmount()
  })

  inBoth('a detached HEAD is labelled on its commit and in the header', async (say, $, on) => {
    const w = world(on, args => (args[0] === 'symbolic-ref' ? { exitCode: 1, stdout: '' } : undefined))

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: say(/detached HEAD @ 3333333/, /HEAD détachée @ 3333333/) }))).toBeDefined()
    expect((await rowTexts(ui)).find(row => row.includes('Merge branch'))).toContain(say('detached HEAD', 'HEAD détachée'))
    await ui.unmount()
  })

  inBoth('a linked worktree says so in the header', async (say, $, on) => {
    const w = world(on, args =>
      args[0] === 'rev-parse' && args.includes('--show-toplevel')
        ? { exitCode: 0, stdout: '/work/demo-wt\n/work/demo/.git/worktrees/demo-wt\n/work/demo/.git\n' }
        : undefined,
    )

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /demo-wt · ⎇ main/ }))?.text).toContain(say('linked worktree', 'worktree secondaire'))
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

describe('finding, comparing, the help (lot B)', () => {
  inBoth('the most used keys are drawn with the help key last; the others are drawn hidden, and h lists them all', async (say, $, on) => {
    const w = world(on)

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const hidden = (await ui.findAll({ type: 'Box' })).find(box => box.props.display === 'none')
    const hiddenKeys = ((hidden?.children ?? []) as { props?: { hotkey?: string } }[]).map(child => child.props?.hotkey)

    expect(await ui.find({ key: 'key-g' })).toBeDefined()
    expect((await ui.find({ key: 'key-h' }))?.props.label).toBe(say('help', 'aide'))
    expect(hiddenKeys).toContain('z')
    expect(hiddenKeys).not.toContain('j')

    await ui.press({ key: 'key-h' })
    expect(await ui.find({ type: 'Text', text: say(/ctree · help/, /ctree · aide/) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: say(/full width above the prompt/, /pleine largeur au-dessus du prompt/) })).toBeDefined()

    await ui.press({ key: 'key-q' })
    expect(await ui.find({ type: 'Text', text: say(/ctree · help/, /ctree · aide/) })).toBeUndefined()
    await ui.unmount()
  })

  inBoth('g asks what to find; Enter lists the commits; Enter on one selects it in the graph, highlighted', async (say, $, on) => {
    const w = world(on, args => {
      if (args[0] === 'log' && args.some(arg => arg.startsWith('--grep='))) return { exitCode: 0, stdout: logOf([COMMITS[6]!]) }
      if (args[0] === 'log' && args.some(arg => arg.startsWith('--author='))) return { exitCode: 0, stdout: '' }

      return undefined
    })

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-g' })
    expect((await ui.find({ key: 'search-query' }))?.props.placeholder).toBe(say('message, author, hash or file', 'message, auteur, hash ou fichier'))

    await ui.input({ key: 'search-query', text: 'parsing' })
    await w.clock.settle()

    expect(w.runs.find(args => args.includes('--grep=parsing'))).toContain('--fixed-strings')

    const hit = await ui.find({ key: `hit-${h('7')}` })

    expect(hit?.text).toContain('Parsing de git log')
    expect(hit?.text).toContain('message')

    await ui.press({ key: `hit-${h('7')}` })
    await w.clock.settle()

    expect((await rowTexts(ui)).find(row => row.startsWith('❯'))).toContain('Parsing de git log')
    expect((await ui.find({ type: 'Text', text: say(/⌕ "parsing" 1\/1/, /⌕ « parsing » 1\/1/) }))).toBeDefined()

    // With a search on, n and b come first among the keys after ⏎ (short labels under 120 columns).
    expect((await ui.find({ key: 'key-n' }))?.props.label).toBe(say('next', 'suiv.'))
    expect((await ui.find({ key: 'key-b' }))?.props.label).toBe(say('prev.', 'préc.'))
    await ui.press({ key: 'key-b' })
    expect((await rowTexts(ui)).find(row => row.startsWith('❯'))).toContain('Parsing de git log')
    await ui.unmount()
  })

  test('m marks a commit, d on another lists the files between them, Enter shows one’s diff', async ($, on) => {
    const w = world(on, args => {
      if (args[0] === 'diff' && args.includes('--name-status')) return { exitCode: 0, stdout: 'M\0a.txt\0' }
      if (args[0] === 'diff' && args.includes('--numstat') && !args.includes('--no-index')) return { exitCode: 0, stdout: '3\t1\ta.txt\0' }

      return undefined
    })

    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'key-m' })
    await ui.press({ key: 'key-j' })
    await ui.press({ key: 'key-d' })
    await w.clock.settle()

    expect((await ui.find({ type: 'Text', text: /⇄ 4444444/ }))?.text).toContain('→ 3333333')
    expect((await ui.find({ key: 'cmp-0' }))?.text).toContain('a.txt')

    await ui.press({ key: 'cmp-0' })
    await w.clock.settle()

    expect((await ui.find({ type: 'Text', text: /a\.txt · 4444444 → 3333333/ }))).toBeDefined()
    expect(w.runs.some(args => args[0] === 'diff' && args.includes(h('4')) && args.includes(h('3')) && args.at(-1) === 'a.txt')).toBe(true)
    await ui.unmount()
  })
})

describe('the language', () => {
  const labelOfHelp = async ($: Engine, w: ReturnType<typeof world>) => {
    await openPane($, w)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const label = (await ui.find({ key: 'key-h' }))?.props.label

    await ui.unmount()

    return label
  }

  test('auto, with nothing set: English', async ($, on) => {
    expect(await labelOfHelp($, world(on))).toBe('help')
  })

  test('auto follows the locale: LC_ALL first, then LC_MESSAGES, then LANG', async ($, on) => {
    expect(await labelOfHelp($, world(on, undefined, {}, { LANG: 'fr_FR.UTF-8' }))).toBe('aide')
  })

  test('auto: LC_ALL wins over LANG', async ($, on) => {
    expect(await labelOfHelp($, world(on, undefined, {}, { LC_ALL: 'en_US.UTF-8', LANG: 'fr_FR.UTF-8' }))).toBe('help')
  })

  test('auto follows Claude Code’s own language setting before the locale', async ($, on) => {
    on('settings.read', () => ({ value: { language: 'french' } }))

    expect(await labelOfHelp($, world(on, undefined, {}, { LANG: 'en_US.UTF-8' }))).toBe('aide')
  })

  test('set to en, it stays English whatever the locale', { options: { language: 'en' } }, async ($, on) => {
    expect(await labelOfHelp($, world(on, undefined, {}, { LANG: 'fr_FR.UTF-8' }))).toBe('help')
  })
})
