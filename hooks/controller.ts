// The pane's state and everything that changes it: loading, refreshing,
// selection, unfolding, the diff view, the question for Claude, and the three
// changes (branch, tag, push), each held in a band until confirmed. It
// reaches Claude Code only through `Host`, which register.tsx builds from `$`.

import {
  type Action,
  nextVersion,
  planPush,
  switchAction,
  switchTargets,
  tagAction,
  tagNameError,
} from '../src/git-actions'
import { PAGE_SIZE, sshCommand } from '../src/git-commands'
import {
  commitKey,
  flatten,
  focusMove,
  type Item,
  step,
  type Unfolded,
  WIP_KEY,
  windowTop,
} from '../src/list'
import {
  type Diff,
  loadCommitDiff,
  loadCommitFiles,
  loadMore,
  loadSnapshot,
  loadStatus,
  loadTips,
  loadWipDiff,
  loadWipFiles,
} from '../src/repo'
import { buildView, explainCommitPrompt, explainFilePrompt, explainWipPrompt, type View, WIP } from '../src/rows'
import type { Commit, FileChange, GitResult, GitRunner, Snapshot } from '../src/types'

export type Host = {
  git: GitRunner
  /** Runs one of the writes src/git-actions.ts builds; refuses any other. */
  write: GitRunner
  /** Appends a note to the conversation that Claude reads and the person does not. */
  note: (text: string) => Promise<void>
  /** Whether the person set an ssh command of their own in the environment. */
  hasOwnSsh: () => Promise<boolean>
  cwd: () => Promise<string>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  invalidate: () => void
  /** Opens (or raises) the pane; `focus` asks for the keyboard. */
  open: (focus: boolean) => Promise<void>
  close: () => Promise<void>
  /** Moves the pane's focus ring onto a row; quiet when the pane lacks the keys. */
  focus: (key: string) => Promise<void>
  /** Puts text in the prompt without sending it; false where no prompt took it. */
  fill: (text: string) => Promise<boolean>
  baseline: {
    get: () => Promise<readonly string[] | null>
    set: (tips: readonly string[]) => Promise<void>
  }
}

export type DiffMode = {
  kind: 'diff'
  /** The commit's hash, or WIP. */
  under: string
  commit: Commit | null
  change: FileChange
  diff: Diff | { kind: 'loading' } | { kind: 'error'; message: string }
}

/** The band in place of the keys while a change waits for its confirmation. */
export type Band =
  | { kind: 'preparing'; title: string }
  | { kind: 'confirm'; action: Action }
  /** Several branches at the commit: each choice is its own confirmation. */
  | { kind: 'choose'; title: string; actions: Action[] }
  | { kind: 'tag-form'; commit: Commit; name: string; message: string; error: string | null }
  | { kind: 'running'; action: Action }
  | { kind: 'info'; title: string; lines: string[]; isError: boolean }

export type Model = {
  snapshot: Snapshot | null
  view: View | null
  isLoading: boolean
  more: 'none' | 'available' | 'loading'
  unfolded: ReadonlyMap<string, Unfolded>
  /** Key of the selected row (`wip`, `c:<hash>`, `f:<under>:<i>`). */
  selected: string | null
  /** First list row the window shows. */
  top: number
  mode: { kind: 'list' } | DiffMode
  /** A line shown in place of the header until the next action. */
  notice: string | null
  /** The next Escape returns to the prompt without closing the pane. */
  isEscapeKept: boolean
  /** A change being prepared, confirmed or run. */
  action: Band | null
}

export const INITIAL: Model = {
  snapshot: null,
  view: null,
  isLoading: false,
  more: 'none',
  unfolded: new Map(),
  selected: null,
  top: 0,
  mode: { kind: 'list' },
  notice: null,
  isEscapeKept: false,
  action: null,
}

/** Rows from the window's end at which the next page starts loading. */
const PREFETCH_ROWS = 15
export const REFRESH_DEBOUNCE_MS = 150
const NOTICE_MS = 8000
const PUSH_TIMEOUT_MS = 120_000
const WRITE_TIMEOUT_MS = 30_000

export type Controller = ReturnType<typeof createController>

export function createController(host: Host) {
  let model: Model = INITIAL
  let windowSize = 20
  let isOpen = false
  let generation = 0
  let pending: { scope: 'all' | 'status'; timer: { cancel: () => void } } | null = null
  let noticeTimer: { cancel: () => void } | null = null
  let running: Promise<void> = Promise.resolve()

  const set = (patch: Partial<Model>) => {
    model = { ...model, ...patch }
    host.invalidate()
  }

  const repoOf = () => (model.snapshot?.kind === 'repo' ? model.snapshot : null)

  const hasWip = () => (repoOf()?.status.length ?? 0) > 0

  const itemsOf = (from: Model = model): Item[] =>
    from.snapshot?.kind === 'repo' ? flatten(from.snapshot.commits, from.unfolded, from.more) : []

  const indexOf = (key: string | null, items: readonly Item[]): number => {
    if (key === WIP_KEY && hasWip()) return -1
    const index = items.findIndex(item => item.key === key)

    return index === -1 ? (hasWip() && items.length === 0 ? -1 : 0) : index
  }

  const keyOf = (index: number, items: readonly Item[]): string | null =>
    index === -1 ? WIP_KEY : items[index]?.key ?? null

  /** Selects a row, keeps it in the window, and fetches the next page near the end. */
  const select = (index: number, items: readonly Item[] = itemsOf()) => {
    const top = windowTop(items.length, Math.max(index, 0), model.top, windowSize)

    set({ selected: keyOf(index, items), top, notice: null, isEscapeKept: false })

    if (model.more === 'available' && index >= items.length - PREFETCH_ROWS) {
      void more()
    }
  }

  /** Reloads the repository: all of it, or only the working tree's status. */
  const refresh = async (scope: 'all' | 'status' = 'all') => {
    const ticket = ++generation
    const before = model
    const repo = repoOf()

    try {
      if (scope === 'status' && repo) {
        const status = await loadStatus(host.git, repo.repo.toplevel)

        if (ticket === generation && status !== null) {
          adopt({ ...repo, status }, before)
        }

        return
      }

      set({ isLoading: true })

      const cwd = await host.cwd()
      let baseline = await host.baseline.get()

      if (baseline === null) {
        baseline = await loadTips(host.git, cwd)
        await host.baseline.set(baseline)
      }

      const count = Math.max(PAGE_SIZE, repo?.commits.length ?? 0)
      const snapshot = await loadSnapshot(host.git, cwd, { count, baseline })

      if (ticket === generation) {
        adopt(snapshot, before)
      }
    } catch (error) {
      if (ticket === generation) {
        adopt({ kind: 'error', cwd: repo?.repo.toplevel ?? '', message: messageOf(error) }, before)
      }
    }
  }

  /** Takes a new snapshot, keeping the selection, the unfolded rows and the place. */
  const adopt = (snapshot: Snapshot, before: Model) => {
    if (snapshot.kind !== 'repo') {
      set({ snapshot, view: null, isLoading: false, more: 'none', unfolded: new Map(), mode: { kind: 'list' } })
      return
    }

    const known = new Set(snapshot.commits.map(commit => commit.hash))
    const unfolded = new Map([...before.unfolded].filter(([under]) => under === WIP ? snapshot.status.length > 0 : known.has(under)))

    if (unfolded.has(WIP)) {
      unfolded.set(WIP, { state: 'loading' })
    }

    const next: Model = {
      ...model,
      snapshot,
      view: buildView(snapshot),
      isLoading: false,
      more: snapshot.hasMore ? 'available' : 'none',
      unfolded,
    }
    const items = itemsOf(next)
    const headKey = snapshot.head.hash ? commitKey(snapshot.head.hash) : null
    const isKept = model.selected !== null && (items.some(item => item.key === model.selected) || (model.selected === WIP_KEY && snapshot.status.length > 0))
    const selected = isKept ? model.selected : headKey ?? keyOf(snapshot.status.length > 0 ? -1 : 0, items)
    const index = Math.max(0, items.findIndex(item => item.key === selected))

    model = { ...next, selected, top: windowTop(items.length, index, model.top, windowSize) }

    if (model.mode.kind === 'diff' && model.mode.under !== WIP && !known.has(model.mode.under)) {
      model = { ...model, mode: { kind: 'list' } }
    }

    host.invalidate()

    if (unfolded.has(WIP)) {
      void unfoldWip()
    }
  }

  /** Loads the next page of history. */
  const more = async () => {
    const repo = repoOf()

    if (!repo || model.more !== 'available') {
      return
    }

    const ticket = generation

    set({ more: 'loading' })

    try {
      const next = await loadMore(host.git, repo)

      if (ticket === generation) {
        model = { ...model, snapshot: next, view: buildView(next), more: next.hasMore ? 'available' : 'none' }
        host.invalidate()
      }
    } catch {
      set({ more: 'available' })
    }
  }

  const unfoldWip = async () => {
    const repo = repoOf()

    if (!repo) {
      return
    }

    try {
      const files = await loadWipFiles(host.git, repo.repo.toplevel, repo.status, repo.head.hash !== null)

      setUnfolded(WIP, { state: 'ready', files })
    } catch (error) {
      setUnfolded(WIP, { state: 'error', message: messageOf(error) })
    }
  }

  const setUnfolded = (under: string, state: Unfolded | null) => {
    const unfolded = new Map(model.unfolded)

    if (state === null) {
      unfolded.delete(under)
    } else {
      unfolded.set(under, state)
    }

    const next = { ...model, unfolded }
    const items = itemsOf(next)

    model = { ...next, top: windowTop(items.length, indexOf(model.selected, items), model.top, windowSize) }
    host.invalidate()
  }

  /** Unfolds or folds a commit's files (or the uncommitted changes'). */
  const toggle = async (under: string) => {
    const repo = repoOf()

    set({ notice: null, isEscapeKept: false })

    if (!repo) {
      return
    }

    if (model.unfolded.has(under)) {
      return setUnfolded(under, null)
    }

    setUnfolded(under, { state: 'loading' })

    if (under === WIP) {
      return unfoldWip()
    }

    const commit = repo.commits.find(one => one.hash === under)

    if (!commit) {
      return setUnfolded(under, null)
    }

    try {
      setUnfolded(under, { state: 'ready', files: await loadCommitFiles(host.git, repo.repo.toplevel, commit) })
    } catch (error) {
      setUnfolded(under, { state: 'error', message: messageOf(error) })
    }
  }

  /** Shows one file's diff in place of the list. */
  const openDiff = async (under: string, change: FileChange) => {
    const repo = repoOf()

    if (!repo) {
      return
    }

    const commit = under === WIP ? null : repo.commits.find(one => one.hash === under) ?? null
    const mode: DiffMode = { kind: 'diff', under, commit, change, diff: { kind: 'loading' } }

    set({ mode, notice: null, isEscapeKept: false })

    try {
      const diff = commit
        ? await loadCommitDiff(host.git, repo.repo.toplevel, commit, change)
        : await loadWipDiff(host.git, repo.repo.toplevel, change)

      if (model.mode === mode) {
        set({ mode: { ...mode, diff } })
      }
    } catch (error) {
      if (model.mode === mode) {
        set({ mode: { ...mode, diff: { kind: 'error', message: messageOf(error) } } })
      }
    }
  }

  const showNotice = (notice: string, isEscapeKept: boolean) => {
    noticeTimer?.cancel()
    set({ notice, isEscapeKept })
    noticeTimer = host.after(NOTICE_MS, () => {
      if (model.notice === notice) {
        set({ notice: null })
      }
    })
  }

  /** The pane is gone: stop following tool calls until it opens again. */
  const closed = () => {
    isOpen = false
    pending?.timer.cancel()
    pending = null
    model = {
      ...model,
      mode: { kind: 'list' },
      notice: null,
      isEscapeKept: false,
      action: model.action?.kind === 'running' ? model.action : null,
    }
  }

  /** The commit of the selected row, or of the file row under it. */
  const selectedCommit = (): Commit | null => {
    const item = itemsOf().find(one => one.key === model.selected)
    const hash = item?.kind === 'commit' ? item.commit.hash : item ? item.under : null

    return repoOf()?.commits.find(commit => commit.hash === hash) ?? null
  }

  /** Shows a band, the ring on `focusKey` (the cancel key, so a stray Enter cancels). */
  const openBand = (band: Band | null, focusKey?: string) => {
    set({ action: band, notice: null, isEscapeKept: false })

    if (focusKey) {
      void host.focus(focusKey).catch(() => undefined)
    }
  }

  /** Back to the list's keys, the ring on the selected row. */
  const closeBand = () => {
    openBand(null, model.selected ?? undefined)
  }

  /** Lets ssh fail rather than prompt, unless the person set their own ssh command. */
  const sshEnv = async (toplevel: string): Promise<Record<string, string>> => {
    if (await host.hasOwnSsh()) {
      return {}
    }

    const configured = await host.git(sshCommand(), { cwd: toplevel })

    return configured.code === 0 ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
  }

  return {
    get model() {
      return model
    },
    get isOpen() {
      return isOpen
    },
    items: () => itemsOf(),
    selectedIndex: () => indexOf(model.selected, itemsOf()),
    hasWip,

    /** Records which commits the refs point at as the session starts. */
    async recordBaseline() {
      if ((await host.baseline.get()) === null) {
        await host.baseline.set(await loadTips(host.git, await host.cwd()))
      }
    },

    /** /gittree opened the pane: load it afresh. */
    opened() {
      isOpen = true
      void refresh()
    },

    /** The pane was drawn: load what it shows if nothing is loaded yet. */
    shown() {
      isOpen = true

      if (model.snapshot === null && !model.isLoading) {
        void refresh()
      }
    },

    closed,

    /** Rows the window holds, from the pane's height. */
    setWindowSize(rows: number) {
      windowSize = Math.max(1, rows)
      model = { ...model, top: windowTop(itemsOf().length, Math.max(0, indexOf(model.selected, itemsOf())), model.top, windowSize) }
    },

    refresh,

    /** Settles once the last scheduled refresh has. */
    idle: () => running,

    /** A refresh a moment after the last of a burst of tool calls. */
    schedule(scope: 'all' | 'status') {
      const merged = pending?.scope === 'all' ? 'all' : scope

      pending?.timer.cancel()
      pending = {
        scope: merged,
        timer: host.after(REFRESH_DEBOUNCE_MS, () => {
          pending = null
          running = refresh(merged)
        }),
      }
    },

    /** j / k: the next or previous row, and the ring onto it. */
    move(direction: 1 | -1) {
      const items = itemsOf()
      const index = step(items, hasWip(), indexOf(model.selected, items), direction)

      select(index, items)

      const key = keyOf(index, items)

      if (key) {
        void host.focus(key).catch(() => undefined)
      }
    },

    /**
     * The person moved the pane's focus ring: follow it with the selection,
     * or keep it in place where it would wrap past an end.
     */
    ringMoved(target: string | undefined): 'stay' | 'go' {
      if (model.mode.kind !== 'list' || model.snapshot?.kind !== 'repo' || model.action) {
        return 'go'
      }

      const items = itemsOf()
      const move = focusMove({
        items,
        hasWip: hasWip(),
        selected: indexOf(model.selected, items),
        target,
        top: model.top,
        size: windowSize,
      })

      if (move.kind === 'stay') {
        if (move.isAtEnd) {
          void more()
        }

        return 'stay'
      }

      if (move.kind === 'select') {
        select(move.index, items)
      }

      return 'go'
    },

    /** The wheel over the list: move the window, the selection kept inside it. */
    scrolled(by: number) {
      const items = itemsOf()
      const top = Math.max(0, Math.min(model.top + by, Math.max(0, items.length - windowSize)))
      const index = indexOf(model.selected, items)
      const inside = Math.min(Math.max(index, top), top + windowSize - 1)

      set({ top, selected: index === -1 ? model.selected : keyOf(inside, items) })

      if (model.more === 'available' && top + windowSize >= items.length - PREFETCH_ROWS) {
        void more()
      }
    },

    /** Enter on a row; nothing while a change waits in the band. */
    press(item: Item | 'wip') {
      if (model.action) {
        return
      }

      if (item === 'wip') {
        return toggle(WIP)
      }

      select(itemsOf().findIndex(one => one.key === item.key))

      if (item.kind === 'commit') return toggle(item.commit.hash)
      if (item.kind === 'file') return openDiff(item.under, item.change)
    },

    /** q, and Escape in the diff view: back to the list. */
    back() {
      set({ mode: { kind: 'list' }, notice: null })
    },

    /** q: closes the pane. Our own close raises no hook of ours, so say it here. */
    async close() {
      await host.close()
      closed()
    },

    /** e: a question about the selected row, put in the prompt, not sent. */
    async explain() {
      const repo = repoOf()

      if (!repo) {
        return
      }

      const text = promptFor(model, repo.commits, itemsOf(), repo.status.length)

      if (text === null) {
        return
      }

      const isFilled = await host.fill(text)

      showNotice(
        isFilled
          ? 'Question prête dans le prompt · Échap pour y aller, le panneau reste ouvert'
          : 'Le prompt n’a pas pu être rempli ici',
        isFilled,
      )
    },

    /** c: switch to the selected commit's branch (a choice when it has several). */
    beginSwitch() {
      const repo = repoOf()
      const commit = selectedCommit()

      if (!repo) return
      if (!commit) return showNotice('Sélectionne un commit pour changer de branche', false)

      const actions = switchTargets(repo, commit.hash).map(target => switchAction(repo, target))
      const [only] = actions

      if (!only) return showNotice('HEAD est déjà sur ce commit', false)

      openBand(actions.length === 1 ? { kind: 'confirm', action: only } : { kind: 'choose', title: '⎇ Changer de branche', actions }, 'act-n')
    },

    /** t: a form for a tag on the selected commit, its name guessed from the last version. */
    beginTag() {
      const repo = repoOf()
      const commit = selectedCommit()

      if (!repo) return
      if (!commit) return showNotice('Sélectionne un commit à tagger', false)

      const tags = repo.refs.filter(ref => ref.kind === 'tag').map(ref => ref.name)

      openBand({ kind: 'tag-form', commit, name: nextVersion(tags), message: '', error: null }, 'tag-name')
    },

    /** What the person types in the tag form; drawn again only to clear an error. */
    setTagField(field: 'name' | 'message', value: string) {
      const band = model.action

      if (band?.kind !== 'tag-form') return

      model = { ...model, action: { ...band, [field]: value, error: field === 'name' ? null : band.error } }

      if (band.error !== null && field === 'name') {
        host.invalidate()
      }
    },

    /** Enter in the tag form: the name checked, then the confirmation. */
    submitTag() {
      const repo = repoOf()
      const band = model.action

      if (!repo || band?.kind !== 'tag-form') return

      const name = band.name.trim()
      const error = tagNameError(name, repo.refs.filter(ref => ref.kind === 'tag').map(ref => ref.name))

      if (error) {
        set({ action: { ...band, error } })
        return
      }

      openBand({ kind: 'confirm', action: tagAction(band.commit, name, band.message) }, 'act-n')
    },

    /** p: what pushing the current branch would send, read before it asks. */
    async beginPush() {
      const repo = repoOf()

      if (!repo) return

      const band: Band = { kind: 'preparing', title: '↑ Préparation du push…' }

      openBand(band)

      try {
        const plan = await planPush(host.git, repo, await sshEnv(repo.repo.toplevel))

        if (model.action !== band) return

        openBand(
          plan.kind === 'ready'
            ? { kind: 'confirm', action: plan.action }
            : { kind: 'info', title: plan.title, lines: [plan.reason], isError: false },
          'act-n',
        )
      } catch (error) {
        if (model.action === band) {
          openBand({ kind: 'info', title: '↑ Push impossible', lines: [messageOf(error)], isError: true }, 'act-n')
        }
      }
    },

    /** y (or the chosen number): runs the change, tells Claude, reloads the graph. */
    async confirm(index = 0) {
      const repo = repoOf()
      const band = model.action
      const action = band?.kind === 'confirm' ? band.action : band?.kind === 'choose' ? band.actions[index] : undefined

      if (!repo || !action) return

      set({ action: { kind: 'running', action } })

      try {
        const toplevel = repo.repo.toplevel
        const env = action.kind === 'push' ? await sshEnv(toplevel) : {}
        const timeoutMs = action.kind === 'push' ? PUSH_TIMEOUT_MS : WRITE_TIMEOUT_MS
        const result = await host.write(action.args, { cwd: toplevel, env, timeoutMs })

        if (result.code !== 0) {
          openBand({ kind: 'info', title: `✗ ${action.title}`, lines: errorLines(result), isError: true }, 'act-n')
          return
        }

        closeBand()
        showNotice(action.success, false)
        void host.note(action.note).catch(() => undefined)
        await refresh('all')
      } catch (error) {
        openBand({ kind: 'info', title: `✗ ${action.title}`, lines: [messageOf(error)], isError: true }, 'act-n')
      }
    },

    /** n: the band goes, nothing ran. */
    cancelAction() {
      if (model.action && model.action.kind !== 'running') {
        closeBand()
      }
    },

    /** Escape was pressed: whether it closes the pane, or is spent on going back. */
    escape(): 'close' | 'back' | 'keep' {
      if (model.action) {
        if (model.action.kind !== 'running') {
          closeBand()
        }

        return 'back'
      }

      if (model.mode.kind === 'diff') {
        set({ mode: { kind: 'list' } })
        return 'back'
      }

      if (model.isEscapeKept) {
        set({ isEscapeKept: false, notice: null })
        return 'keep'
      }

      return 'close'
    },
  }
}

/** The question for the selected row, or for the file the diff view shows. */
function promptFor(model: Model, commits: readonly Commit[], items: readonly Item[], wipCount: number): string | null {
  if (model.mode.kind === 'diff') {
    const { commit, change } = model.mode

    return commit ? explainFilePrompt(commit, change.path) : explainWipPrompt(wipCount, change.path)
  }

  if (model.selected === WIP_KEY) {
    return explainWipPrompt(wipCount)
  }

  const item = items.find(one => one.key === model.selected)

  if (!item) return null
  if (item.kind === 'commit') return explainCommitPrompt(item.commit)

  if (item.kind === 'file') {
    const commit = commits.find(one => one.hash === item.under)

    return commit ? explainFilePrompt(commit, item.change.path) : explainWipPrompt(wipCount, item.change.path)
  }

  return null
}

/** What git said when it refused, its hints left out, four lines at most. */
function errorLines(result: GitResult): string[] {
  const lines = (result.stderr.trim() || result.stdout.trim())
    .split('\n')
    .map(line => line.replace(/^(fatal|error): /, '').trim())
    .filter(line => line && !line.startsWith('hint:'))

  return lines.length > 0 ? lines.slice(0, 4) : [`git a quitté avec le code ${result.code}`]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
