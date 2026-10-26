import { describe, expect, test } from 'claude-code/testing'

import { createController, type Host } from '../hooks/controller'
import { demoGit, h } from './fixtures'

/** A Host over the scripted demo repository; timers fire when `flush` says. */
function fakeHost() {
  const timers: (() => void)[] = []
  const filled: string[] = []
  const focused: string[] = []
  let baseline: readonly string[] | null = null

  const host: Host = {
    git: async args => {
      const answer = demoGit(args)

      return { code: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr ?? '' }
    },
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

  return { host, filled, focused, flush: () => timers.splice(0).forEach(fn => fn()) }
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
