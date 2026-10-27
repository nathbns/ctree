import { describe, expect, test } from 'claude-code/testing'

import { createController, type Host } from '../hooks/controller'
import { isAllowedWrite } from '../src/git-actions'
import { demoGit, h } from './fixtures'

/**
 * A Host over the scripted demo repository; timers fire when `flush` says.
 * Writes are kept (and refused unless the guard admits them); `refusal`
 * makes git refuse the next one.
 */
function fakeHost() {
  const timers: (() => void)[] = []
  const filled: string[] = []
  const focused: string[] = []
  const writes: string[][] = []
  const notes: string[] = []
  const git = { refusal: null as string | null }
  let baseline: readonly string[] | null = null

  const host: Host = {
    git: async args => {
      const answer = demoGit(args)

      return { code: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr ?? '' }
    },
    write: async args => {
      if (!isAllowedWrite(args)) throw new Error(`refused: ${args.join(' ')}`)

      writes.push([...args])

      const refusal = git.refusal

      git.refusal = null

      return refusal ? { code: 1, stdout: '', stderr: `error: ${refusal}\nhint: try again\n` } : { code: 0, stdout: '', stderr: '' }
    },
    note: async text => {
      notes.push(text)
    },
    hasOwnSsh: async () => false,
    cwd: async () => '/work/demo',
    after: (ms, fn) => {
      timers.push(fn)

      return { cancel: () => timers.splice(timers.indexOf(fn), 1) }
    },
    invalidate: () => undefined,
    open: async () => undefined,
    close: async () => undefined,
    focus: async key => {
      focused.push(key)
    },
    fill: async text => {
      filled.push(text)

      return true
    },
    baseline: {
      get: async () => baseline,
      set: async tips => {
        baseline = tips
      },
    },
  }

  return { host, filled, focused, writes, notes, git, flush: () => timers.splice(0).forEach(fn => fn()) }
}

async function loaded() {
  const fake = fakeHost()
  const ctl = createController(fake.host)

  ctl.opened()
  await ctl.refresh()

  return { ...fake, ctl }
}

describe('Escape', () => {
  test('in the diff view it goes back to the list and keeps the pane', async () => {
    const { ctl } = await loaded()
    const merge = ctl.items().find(item => item.key === `c:${h('3')}`)

    if (!merge) throw new Error('no merge row')

    await ctl.press(merge)

    const file = ctl.items().find(item => item.kind === 'file')

    if (!file) throw new Error('no file row')

    await ctl.press(file)

    expect(ctl.model.mode.kind).toBe('diff')
    expect(ctl.escape()).toBe('back')
    expect(ctl.model.mode.kind).toBe('list')
    expect(ctl.escape()).toBe('close')
  })

  test('right after e it hands the keys back to the prompt once, then closes', async () => {
    const { ctl, filled } = await loaded()

    await ctl.explain()

    expect(filled[0]).toContain('3333333')
    expect(ctl.model.notice).toContain('Question prête')
    expect(ctl.escape()).toBe('keep')
    expect(ctl.model.notice).toBeNull()
    expect(ctl.escape()).toBe('close')
  })
})

describe('the focus ring', () => {
  test('j and k move the selection and take the ring along', async () => {
    const { ctl, focused } = await loaded()

    ctl.move(1)

    expect(ctl.model.selected).toBe(`c:${h('4')}`)
    expect(focused).toEqual([`c:${h('4')}`])

    ctl.move(-1)
    ctl.move(-1)

    expect(focused).toEqual([`c:${h('4')}`, `c:${h('3')}`, `c:${h('2')}`])
  })

  test('a move onto a row selects it; past the last row it stays put', async () => {
    const { ctl } = await loaded()
    const items = ctl.items()
    const last = items[items.length - 1]

    expect(ctl.ringMoved(`c:${h('4')}`)).toBe('go')
    expect(ctl.model.selected).toBe(`c:${h('4')}`)

    ctl.ringMoved(last?.key)

    expect(ctl.model.selected).toBe(last?.key)
    // Down from the last row would wrap to the keys below the list.
    expect(ctl.ringMoved('key-j')).toBe('stay')
  })

  test('up from the pinned uncommitted row does not wrap to the bottom', async () => {
    const { ctl } = await loaded()

    expect(ctl.ringMoved('wip')).toBe('go')
    expect(ctl.model.selected).toBe('wip')
    expect(ctl.ringMoved('key-q')).toBe('stay')
  })
})

describe('changes wait for their confirmation', () => {
  test('c on a branch: nothing runs until y, then git switch, a note for Claude, a reload', async () => {
    const { ctl, writes, notes, focused } = await loaded()

    ctl.ringMoved(`c:${h('1')}`)
    ctl.beginSwitch()

    expect(ctl.model.action).toMatchObject({ kind: 'confirm', action: { args: ['switch', 'feature/ui'] } })
    expect(focused[focused.length - 1]).toBe('act-n')
    expect(writes).toEqual([])

    await ctl.confirm()

    expect(writes).toEqual([['switch', 'feature/ui']])
    expect(notes[0]).toContain('feature/ui')
    expect(ctl.model.action).toBeNull()
    expect(ctl.model.notice).toBe('✓ Sur feature/ui')
  })

  test('n, or Escape, drops the change and runs nothing', async () => {
    const { ctl, writes } = await loaded()

    ctl.ringMoved(`c:${h('1')}`)
    ctl.beginSwitch()
    ctl.cancelAction()

    expect(ctl.model.action).toBeNull()

    ctl.beginSwitch()

    expect(ctl.escape()).toBe('back')
    expect(ctl.model.action).toBeNull()
    expect(writes).toEqual([])
  })

  test('rows do not unfold while a change waits', async () => {
    const { ctl } = await loaded()
    const merge = ctl.items().find(item => item.key === `c:${h('1')}`)

    ctl.ringMoved(`c:${h('1')}`)
    ctl.beginSwitch()
    await ctl.press(merge!)

    expect(ctl.model.unfolded.size).toBe(0)
  })

  test('on HEAD’s own commit there is nothing to switch to', async () => {
    const { ctl } = await loaded()

    ctl.beginSwitch()

    expect(ctl.model.action).toBeNull()
    expect(ctl.model.notice).toContain('déjà')
  })

  test('t: the next version is offered, a taken name refused, then the tag made', async () => {
    const { ctl, writes } = await loaded()

    ctl.beginTag()

    expect(ctl.model.action).toMatchObject({ kind: 'tag-form', name: 'v0.3.0' })

    ctl.setTagField('name', 'v0.2.0')
    ctl.submitTag()

    expect(ctl.model.action).toMatchObject({ kind: 'tag-form', error: 'le tag v0.2.0 existe déjà' })

    ctl.setTagField('name', 'v0.3.0')
    ctl.setTagField('message', 'Version 0.3')
    ctl.submitTag()

    expect(ctl.model.action).toMatchObject({ kind: 'confirm', action: { kind: 'tag' } })

    await ctl.confirm()

    expect(writes).toEqual([['tag', '-a', 'v0.3.0', '-m', 'Version 0.3', h('3')]])
  })

  test('p: the plan is read first; the push runs on y', async () => {
    const { ctl, writes } = await loaded()

    await ctl.beginPush()

    expect(ctl.model.action).toMatchObject({ kind: 'confirm', action: { args: ['push', '--follow-tags', 'origin', 'main'] } })

    await ctl.confirm()

    expect(writes).toEqual([['push', '--follow-tags', 'origin', 'main']])
  })

  test('a refusal from git stays on screen, its hints left out, until dismissed', async () => {
    const { ctl, git } = await loaded()

    ctl.ringMoved(`c:${h('1')}`)
    ctl.beginSwitch()
    git.refusal = 'Your local changes would be overwritten by checkout'
    await ctl.confirm()

    expect(ctl.model.action).toEqual({
      kind: 'info',
      title: '✗ ⎇ Passer sur feature/ui',
      lines: ['Your local changes would be overwritten by checkout'],
      isError: true,
    })

    ctl.cancelAction()

    expect(ctl.model.action).toBeNull()
  })

  test('several branches on the commit: each choice is its own confirmation', async () => {
    const { ctl, writes, host } = await loaded()
    const git = host.git

    host.git = async (args, options) =>
      args[0] === 'for-each-ref'
        ? { code: 0, stdout: `refs/heads/feature/ui\x1f${h('1')}\x1f\x1f\x1f\x1f\nrefs/heads/hotfix\x1f${h('1')}\x1f\x1f\x1f\x1f\nrefs/heads/main\x1f${h('3')}\x1f\x1forigin/main\x1f\x1f\n`, stderr: '' }
        : git(args, options)
    await ctl.refresh()
    ctl.ringMoved(`c:${h('1')}`)
    ctl.beginSwitch()

    expect(ctl.model.action).toMatchObject({ kind: 'choose' })

    await ctl.confirm(1)

    expect(writes).toEqual([['switch', 'hotfix']])
  })
})

describe('closing', () => {
  test('q closes the pane and tool calls stop reloading it', async () => {
    const { ctl } = await loaded()

    expect(ctl.isOpen).toBe(true)
    await ctl.close()
    expect(ctl.isOpen).toBe(false)
  })
})

describe('refreshes', () => {
  test('a burst of scheduled refreshes runs once, the widest scope winning', async () => {
    const { ctl, flush, host } = await loaded()
    let runs = 0
    const git = host.git

    host.git = async (args, options) => {
      if (args[0] === 'log') runs += 1

      return git(args, options)
    }

    ctl.schedule('status')
    ctl.schedule('all')
    ctl.schedule('status')
    flush()
    await ctl.idle()

    expect(runs).toBe(1)
  })

  test('the selection survives a refresh, by its commit', async () => {
    const { ctl } = await loaded()

    ctl.ringMoved(`c:${h('6')}`)
    await ctl.refresh()

    expect(ctl.model.selected).toBe(`c:${h('6')}`)
  })
})
