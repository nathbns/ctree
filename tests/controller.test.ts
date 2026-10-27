import { describe, expect, test } from 'claude-code/testing'

import { createController, type Host, LET_IT_RUN, REFUSE } from '../hooks/controller'
import { isAllowedWrite } from '../src/git-actions'
import type { JournalEntry, RefState } from '../src/journal'
import { type Answer, COMMITS, demoGit, h, linearSnapshot, logOf, nth, type Script } from './fixtures'

/** The demo's commits a search finds: Calcul des lanes, then Parsing de git log. */
const COMMITS_FOUND = [COMMITS[3], COMMITS[6]]

/**
 * A Host over the scripted demo repository; timers fire when `flush` says.
 * Writes are kept (and refused unless the guard admits them); `refusal`
 * makes git refuse the next one.
 */
function fakeHost(script: Script = () => undefined) {
  const runs: string[][] = []
  const timers: (() => void)[] = []
  const filled: string[] = []
  const copied: string[] = []
  const focused: string[] = []
  const writes: string[][] = []
  const notes: string[] = []
  const asked: string[] = []
  const git = { refusal: null as string | null, answer: LET_IT_RUN as string | null }
  // The repository's refs, which the undo writes move for real.
  const repo: RefState = {
    refs: { 'refs/heads/main': h('3'), 'refs/heads/feature/ui': h('1'), 'refs/remotes/origin/main': h('3') },
    head: { branch: 'main', hash: h('3') },
  }
  const stored = new Map<string, unknown>()
  let baseline: readonly string[] | null = null
  let journal: readonly JournalEntry[] | null = null
  let start: (RefState & { at: number }) | null = null

  const refGit = (args: readonly string[]): Answer | undefined => {
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%1f%(objectname)')) {
      return { exitCode: 0, stdout: Object.entries(repo.refs).map(([ref, hash]) => `${ref}\x1f${hash}`).join('\n') + '\n' }
    }
    if (args[0] === 'symbolic-ref') return repo.head.branch ? { exitCode: 0, stdout: `refs/heads/${repo.head.branch}\n` } : { exitCode: 1, stdout: '' }

    return undefined
  }

  const host: Host = {
    git: async args => {
      runs.push([...args])

      const answer: Answer = script(args) ?? refGit(args) ?? demoGit(args)

      return { code: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr ?? '' }
    },
    write: async args => {
      if (!isAllowedWrite(args)) throw new Error(`refused: ${args.join(' ')}`)

      writes.push([...args])

      const refusal = git.refusal

      git.refusal = null

      if (refusal) return { code: 1, stdout: '', stderr: `error: ${refusal}\nhint: try again\n` }

      const [command, a = '', b = ''] = args

      if (command === 'reset' && repo.head.branch) {
        repo.refs[`refs/heads/${repo.head.branch}`] = b
        repo.head = { ...repo.head, hash: b }
      } else if (command === 'switch' && a !== '--detach' && a !== '--track') {
        repo.head = { branch: a, hash: repo.refs[`refs/heads/${a}`] ?? null }
      } else if (command === 'update-ref' && a === '-d') {
        delete repo.refs[b]
      } else if (command === 'update-ref') {
        repo.refs[a] = b
      } else if (command === 'stash' && a === 'create') {
        return { code: 0, stdout: `${h('5')}\n`, stderr: '' }
      }

      return { code: 0, stdout: '', stderr: '' }
    },
    ask: async question => {
      asked.push(question)

      return git.answer
    },
    store: {
      get: async key => stored.get(key),
      set: async (key, value) => {
        stored.set(key, value)
      },
    },
    turns: async () => 4,
    now: async () => 1_800_000_000_000,
    journal: {
      get: async () => journal,
      set: async entries => {
        journal = entries
      },
    },
    start: {
      get: async () => start,
      set: async value => {
        start = value
      },
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
    copy: async text => {
      copied.push(text)

      return true
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

  return { host, runs, filled, copied, focused, writes, notes, asked, git, repo, flush: () => timers.splice(0).forEach(fn => fn()) }
}

/** git for a linear history of 250 commits, `main` and HEAD on the newest. */
const linearGit: Script = args => {
  const all = linearSnapshot(250).commits
  const line = args.join(' ')

  if (args[0] === 'status') return { exitCode: 0, stdout: '' }
  if (args[0] === 'rev-parse' && args.includes('--verify')) return { exitCode: 0, stdout: `${nth(0)}\n` }
  if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: `refs/heads/main\x1f${nth(0)}\x1f\x1f\x1f\x1f\n` }
  if (args[0] !== 'log' || line.includes('..')) return undefined

  const skip = Number(/--skip=(\d+)/.exec(line)?.[1] ?? 0)
  const count = Number(/ -n(\d+)/.exec(line)?.[1] ?? 1000)

  return { exitCode: 0, stdout: logOf(all.slice(skip, skip + count)) }
}

async function loaded(script?: Script) {
  const fake = fakeHost(script)
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

describe('seeing the whole graph', () => {
  test('v folds the linear runs, the selection carried into its fold; Enter opens the fold', async () => {
    const { ctl } = await loaded(linearGit)

    ctl.ringMoved(`c:${nth(5)}`)
    ctl.toggleOverview()
    await ctl.idle()

    // The pages load on by themselves until the folded rows fill the pane:
    // main's commit, the 248 commits under it as one fold, the root.
    expect(ctl.items().map(item => item.key)).toEqual([`c:${nth(0)}`, `z:FOLD:${nth(1)}`, `c:${nth(249)}`])
    expect(ctl.model.selected).toBe(`z:FOLD:${nth(1)}`)

    await ctl.press(ctl.items()[1]!)

    expect(ctl.items()).toHaveLength(250)
    expect(ctl.model.selected).toBe(`c:${nth(1)}`)

    ctl.toggleOverview()

    expect(ctl.model.isOverview).toBe(false)
    expect(ctl.model.selected).toBe(`c:${nth(1)}`)
  })

  test('e on a fold asks about the whole run', async () => {
    const { ctl, filled } = await loaded(linearGit)

    ctl.toggleOverview()
    await ctl.idle()
    ctl.ringMoved(`z:FOLD:${nth(1)}`)
    await ctl.explain()

    expect(filled[0]).toContain('Explique ces 248 commits')
  })

  test('f: the selected branch, then its first parents alone, then every branch again', async () => {
    const { ctl, runs } = await loaded()
    const lastLog = () => runs.filter(args => args[0] === 'log' && !args.join(' ').includes('..')).at(-1)?.join(' ') ?? ''

    ctl.ringMoved(`c:${h('1')}`)
    ctl.cycleFocus()
    await ctl.idle()

    expect(ctl.model.scope).toEqual({ kind: 'focus', ref: 'refs/heads/feature/ui', label: 'feature/ui', isFirstParent: false })
    expect(lastLog()).toContain('refs/heads/feature/ui --')
    expect(lastLog()).not.toContain('--branches')

    ctl.cycleFocus()
    await ctl.idle()

    expect(lastLog()).toContain('--first-parent refs/heads/feature/ui --')

    ctl.cycleFocus()
    await ctl.idle()

    expect(ctl.model.scope).toEqual({ kind: 'all' })
    expect(lastLog()).toContain('--branches --remotes --tags --')
  })

  test('f on a remote-only branch follows the remote ref', async () => {
    const { ctl } = await loaded()

    ctl.ringMoved(`c:${h('4')}`)
    ctl.cycleFocus()

    expect(ctl.model.scope).toMatchObject({ kind: 'focus', ref: 'refs/remotes/origin/feature/lanes', label: 'origin/feature/lanes' })
  })
})

describe('the guard on Claude’s git commands', () => {
  test('a command that loses nothing runs without a question', async () => {
    const { ctl, asked } = await loaded()

    expect(await ctl.guard('git status && git log -n5')).toEqual({})
    expect(await ctl.guard('git commit -am "x"')).toEqual({})
    expect(asked).toEqual([])
  })

  test('reset --hard asks, saying what would go; refused, Claude reads why', async () => {
    const { ctl, asked, git } = await loaded()

    git.answer = REFUSE

    const verdict = await ctl.guard('git reset --hard HEAD~1')

    expect(asked[0]).toContain('Claude veut lancer « git reset --hard HEAD~1 »')
    expect(asked[0]).toContain('1 fichier modifié perdu : a.txt')
    expect(verdict.deny).toContain('la personne a refusé « git reset --hard HEAD~1 »')
    expect(ctl.model.action).toBeNull()
  })

  test('let through, it saves the changes it is about to throw away', async () => {
    const { ctl, writes } = await loaded()

    expect(await ctl.guard('git checkout -- .')).toEqual({ saved: { hash: h('5'), files: 1 } })
    expect(writes).toEqual([['stash', 'create']])
  })

  test('a dismissed question refuses the command', async () => {
    const { ctl, git } = await loaded()

    git.answer = null

    expect((await ctl.guard('git push --force')).deny).toBeDefined()
  })
})

describe('the journal and its undo', () => {
  test('Claude’s commit goes in the journal; u undoes it softly once confirmed, and Claude is told', async () => {
    const { ctl, repo, writes, notes } = await loaded()
    const before = await ctl.watch()

    repo.refs['refs/heads/main'] = h('9')
    repo.head = { branch: 'main', hash: h('9') }
    await ctl.record('git commit -am "wip"', before!, { isSubagent: false })

    expect(ctl.model.journal).toHaveLength(1)
    expect(ctl.model.journal[0]).toMatchObject({ turn: 4, command: 'git commit -am "wip"', moves: [{ ref: 'refs/heads/main', before: h('3'), after: h('9') }] })

    await ctl.beginUndo()

    expect(ctl.model.action).toMatchObject({ kind: 'confirm', action: { args: ['reset', '--soft', h('3')] } })
    expect(writes).toEqual([])

    await ctl.confirm()

    expect(repo.refs['refs/heads/main']).toBe(h('3'))
    expect(ctl.model.journal[0]?.isUndone).toBe(true)
    expect(notes.at(-1)).toContain('la personne a annulé ta commande « git commit -am "wip" » (tour 4)')
  })

  test('a reset --hard with saved changes offers both: the branch alone, or the files too', async () => {
    const { ctl, repo } = await loaded()
    const before = await ctl.watch()
    const saved = await ctl.guard('git reset --hard HEAD~2')

    repo.refs['refs/heads/main'] = h('7')
    repo.head = { branch: 'main', hash: h('7') }
    await ctl.record('git reset --hard HEAD~2', before!, { isSubagent: false, ...saved })
    await ctl.beginUndo()

    expect(ctl.model.action).toMatchObject({ kind: 'choose' })

    const band = ctl.model.action

    if (band?.kind !== 'choose') throw new Error('no choice')

    expect(band.actions.map(action => [action.args, ...(action.then ?? [])])).toEqual([
      [['reset', '--keep', h('3')]],
      [['reset', '--keep', h('3')], ['stash', 'apply', h('5')]],
    ])
  })

  test('a command that changed nothing is not journaled; with nothing to undo, u says so', async () => {
    const { ctl } = await loaded()
    const before = await ctl.watch()

    await ctl.record('git log', before!, { isSubagent: false })

    expect(ctl.model.journal).toHaveLength(0)

    await ctl.beginUndo()

    expect(ctl.model.notice).toContain('Rien à annuler')
  })
})

describe('the session view', () => {
  test('what moved since the session started, its commits and HEAD’s files', async () => {
    const { ctl, repo } = await loaded()

    await ctl.recordStart()
    repo.refs['refs/heads/main'] = h('4')
    repo.refs['refs/heads/new'] = h('4')
    await ctl.openSession()

    const mode = ctl.model.mode

    if (mode.kind !== 'session' || !mode.data) throw new Error('no session data')

    expect(mode.data.refs.map(ref => [ref.name, ref.change])).toEqual([
      ['main', 'moved'],
      ['new', 'new'],
    ])
    expect(ctl.escape()).toBe('back')
    expect(ctl.model.mode.kind).toBe('list')
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

describe('comparing two commits', () => {
  /** git telling what changes between two commits, and how far apart they are. */
  const apart: Script = args => {
    if (args[0] === 'diff' && args.includes('--name-status')) return { exitCode: 0, stdout: 'M\0a.txt\0A\0b.txt\0' }
    if (args[0] === 'diff' && args.includes('--numstat') && !args.includes('--no-index')) return { exitCode: 0, stdout: '3\t1\ta.txt\x002\t0\tb.txt\0' }
    if (args[0] === 'rev-list' && args[1] === '--count') return { exitCode: 0, stdout: args[2] === `${h('7')}..${h('1')}` ? '4\n' : '0\n' }

    return undefined
  }

  test('m marks, d on another compares the older with the newer; Enter shows a file, Escape comes back', async () => {
    const { ctl, runs, filled } = await loaded(apart)

    ctl.ringMoved(`c:${h('1')}`)
    ctl.toggleMark()
    expect(ctl.model.mark).toBe(h('1'))

    ctl.ringMoved(`c:${h('7')}`)
    await ctl.beginCompare()

    const mode = ctl.model.mode

    if (mode.kind !== 'compare') throw new Error(`mode ${mode.kind}`)

    expect([mode.from.hash, mode.to?.hash]).toEqual([h('7'), h('1')])
    expect(mode.counts).toEqual({ ahead: 4, behind: 0 })
    expect(mode.files.state === 'ready' && mode.files.files.map(file => [file.status, file.path, file.added])).toEqual([
      ['M', 'a.txt', 3],
      ['A', 'b.txt', 2],
    ])

    await ctl.explain()
    expect(filled.at(-1)).toContain('git diff --stat 7777777 1111111')

    ctl.openCompareFile(1)
    await ctl.idle()
    expect(ctl.model.mode.kind).toBe('diff')
    expect(runs.some(args => args[0] === 'diff' && args.includes(h('7')) && args.includes(h('1')) && args.at(-1) === 'b.txt')).toBe(true)

    expect(ctl.escape()).toBe('back')
    expect(ctl.model.mode.kind).toBe('compare')
    expect(ctl.escape()).toBe('back')
    expect(ctl.model.mode.kind).toBe('list')
    expect(ctl.model.mark).toBe(h('1'))
  })

  test('with no mark, d compares with HEAD; on HEAD itself it says how to mark', async () => {
    const { ctl } = await loaded(apart)

    await ctl.beginCompare()
    expect(ctl.model.notice).toContain('Marque un commit avec m')

    ctl.ringMoved(`c:${h('1')}`)
    await ctl.beginCompare()

    const mode = ctl.model.mode

    expect(mode.kind === 'compare' && [mode.from.hash, mode.to?.hash]).toEqual([h('3'), h('1')])
  })
})

describe('searching', () => {
  const found: Script = args => {
    if (args[0] === 'log' && args.some(arg => arg.startsWith('--grep='))) return { exitCode: 0, stdout: logOf([COMMITS_FOUND[0]!, COMMITS_FOUND[1]!]) }
    if (args[0] === 'log' && args.some(arg => arg.startsWith('--author='))) return { exitCode: 0, stdout: '' }

    return undefined
  }

  test('g opens the field; Enter lists what git found; one chosen is selected in the graph, n goes on, Escape clears it', async () => {
    const { ctl, focused } = await loaded(found)

    ctl.beginSearch()
    expect(ctl.model.action?.kind).toBe('search-form')
    expect(focused.at(-1)).toBe('search-query')

    await ctl.submitSearch('lanes')

    const mode = ctl.model.mode

    expect(mode.kind === 'search' && mode.result?.hits.map(hit => hit.commit.hash)).toEqual([h('4'), h('7')])
    expect(ctl.model.action).toBeNull()
    expect(focused.at(-1)).toBe(`hit-${h('4')}`)

    await ctl.openHit(h('4'))
    expect(ctl.model.mode.kind).toBe('list')
    expect(ctl.model.selected).toBe(`c:${h('4')}`)
    expect(ctl.model.search?.index).toBe(0)

    await ctl.nextHit()
    expect(ctl.model.selected).toBe(`c:${h('7')}`)
    await ctl.nextHit()
    expect(ctl.model.selected).toBe(`c:${h('4')}`)

    expect(ctl.escape()).toBe('back')
    expect(ctl.model.search).toBeNull()
    expect(ctl.escape()).toBe('close')
  })

  test('a result past the pages loaded is loaded up to; one off the history drawn is shown in focus', async () => {
    const far = { ...COMMITS_FOUND[0]!, hash: h('e'), parents: [] }
    const script: Script = args => {
      if (args[0] === 'log' && args.includes(h('e'))) return { exitCode: 0, stdout: logOf([far]) }
      if (args[0] === 'log' && args.some(arg => arg.startsWith('--grep='))) return { exitCode: 0, stdout: logOf([linearSnapshot(250).commits[180]!, far]) }
      if (args[0] === 'log' && args.some(arg => arg.startsWith('--author='))) return { exitCode: 0, stdout: '' }

      return linearGit(args)
    }
    const { ctl } = await loaded(script)

    expect(ctl.model.snapshot?.kind === 'repo' && ctl.model.snapshot.commits.length).toBe(100)

    ctl.beginSearch()
    await ctl.submitSearch('commit')
    await ctl.openHit(nth(180))
    expect(ctl.model.selected).toBe(`c:${nth(180)}`)

    await ctl.openHit(h('e'))
    expect(ctl.model.scope).toEqual({ kind: 'focus', ref: h('e'), label: 'eeeeeee', isFirstParent: false })
    expect(ctl.model.selected).toBe(`c:${h('e')}`)
    expect(ctl.model.notice).toContain('montré en focus')
  })
})

describe('copying, HEAD, stashes and the help', () => {
  test('y puts the selected commit’s full hash on the clipboard', async () => {
    const { ctl, copied } = await loaded()

    ctl.ringMoved(`c:${h('4')}`)
    await ctl.copyHash()

    expect(copied).toEqual([h('4')])
    expect(ctl.model.notice).toContain(h('4'))
  })

  test('i comes back to HEAD from far down the history', async () => {
    const { ctl, focused } = await loaded(linearGit)

    ctl.ringMoved(`c:${nth(90)}`)
    await ctl.jumpHead()

    expect(ctl.model.selected).toBe(`c:${nth(0)}`)
    expect(ctl.model.top).toBe(0)
    expect(focused.at(-1)).toBe(`c:${nth(0)}`)
  })

  test('a stash is in the graph: Enter lists its files, c says what it is, a applies it once confirmed', async () => {
    const stash = [h('a'), `${h('3')} ${h('b')}`, 'Nathan Test', 'n@e.st', '1793000000', 'stash@{0}', 'On main: essai'].join('\x1f')
    const { ctl, writes, notes } = await loaded(args => (args[0] === 'stash' ? { exitCode: 0, stdout: `${stash}\0` } : undefined))
    const row = ctl.items().find(item => item.key === `c:${h('a')}`)

    if (!row) throw new Error('no stash row')

    await ctl.press(row)
    expect(ctl.items().some(item => item.kind === 'file' && item.under === h('a'))).toBe(true)

    ctl.beginSwitch()
    expect(ctl.model.action).toBeNull()
    expect(ctl.model.notice).toContain('Un stash')

    ctl.beginApplyStash()

    const band = ctl.model.action

    expect(band?.kind === 'confirm' && band.action.args).toEqual(['stash', 'apply', h('a')])

    await ctl.confirm()
    expect(writes).toEqual([['stash', 'apply', h('a')]])
    expect(notes[0]).toContain('stash@{0} « On main: essai »')
  })

  test('a with no stash selected says how', async () => {
    const { ctl } = await loaded()

    ctl.beginApplyStash()
    expect(ctl.model.action).toBeNull()
    expect(ctl.model.notice).toContain('Sélectionne un stash')
  })

  test('h shows the help, q comes back', async () => {
    const { ctl } = await loaded()

    ctl.openHelp()
    expect(ctl.model.mode.kind).toBe('help')
    ctl.back()
    expect(ctl.model.mode.kind).toBe('list')
  })
})
