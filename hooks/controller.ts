// The pane's state and everything that changes it: loading, refreshing,
// selection, unfolding, the diff view, the question for Claude, the three
// changes (branch, tag, push) held in a band until confirmed, the guard on
// Claude's git commands, their journal and its undo, and the session view.
// It reaches Claude Code only through `Host`, which register.tsx builds from `$`.

import {
  type Action,
  applyStashAction,
  nextVersion,
  planPush,
  switchAction,
  switchTargets,
  tagAction,
  tagNameError,
} from '../src/git-actions'
import { displayCommand, isSafeRefName } from '../src/git-actions'
import { headRef, PAGE_SIZE, repoInfo, sshCommand } from '../src/git-commands'
import { consequences, gitCalls, losesChanges, readStatus, riskOf } from '../src/guard'
import { appended, describeMoves, journalEntry, type JournalEntry, readRefState, type RefState, undoPlan } from '../src/journal'
import { loadSessionData, prDescriptionPrompt, type SessionData } from '../src/session'
import {
  commitKey,
  flatten,
  foldKey,
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
  loadRangeDiff,
  loadRangeFiles,
  loadSnapshot,
  loadStatus,
  loadTips,
  loadWipDiff,
  loadWipFiles,
} from '../src/repo'
import { type Fold, foldHolding } from '../src/overview'
import {
  buildView,
  explainCommitPrompt,
  explainComparePrompt,
  explainFilePrompt,
  explainRangePrompt,
  explainStashPrompt,
  explainWipPrompt,
  stashCommit,
  type View,
  WIP,
} from '../src/rows'
import { search, type SearchResult } from '../src/search'
import { countRange } from '../src/git-commands'
import type { Commit, FileChange, GitResult, GitRunner, LogScope, RepoSnapshot, Snapshot } from '../src/types'

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
  /** Puts text on the person's clipboard; false where nothing took it. */
  copy: (text: string) => Promise<boolean>
  baseline: {
    get: () => Promise<readonly string[] | null>
    set: (tips: readonly string[]) => Promise<void>
  }
  /** Puts a question to the person in Claude Code's own dialog; null when dismissed or nobody can answer. */
  ask: (question: string, options: readonly string[]) => Promise<string | null>
  /** The conversation's prompt count. */
  turns: () => Promise<number>
  now: () => Promise<number>
  journal: {
    get: () => Promise<readonly JournalEntry[] | null>
    set: (entries: readonly JournalEntry[]) => Promise<void>
  }
  /** Kept across sessions: where ctree is drawn. */
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  /** Where the refs stood when the session started. */
  start: {
    get: () => Promise<(RefState & { at: number }) | null>
    set: (start: RefState & { at: number }) => Promise<void>
  }
}

export type SessionMode = { kind: 'session'; data: SessionData | null; error: string | null }

/**
 * Where ctree is drawn: the pane docked beside the transcript (Claude Code
 * caps it at 45% of the width), or the band above the prompt, as wide as
 * the terminal and up to half as tall.
 */
export type Placement = 'pane' | 'band'

const PLACEMENT_KEY = 'placement'

export type DiffMode = {
  kind: 'diff'
  /** The commit's hash, or WIP. */
  under: string
  commit: Commit | null
  change: FileChange
  diff: Diff | { kind: 'loading' } | { kind: 'error'; message: string }
  /** A file of a comparison: diffed from one commit to the other, and the comparison Escape goes back to. */
  compare?: CompareMode
}

/** Two commits compared (`m`, then `d`): what changes from the older to the newer. */
export type CompareMode = {
  kind: 'compare'
  from: Commit
  /** null: the working tree. */
  to: Commit | null
  files: Unfolded
  /** Commits `to` has that `from` lacks, and the other way round; null for the working tree or until read. */
  counts: { ahead: number; behind: number } | null
  /** The file the ring starts on: the one whose diff was last opened. */
  ring: number
}

/** What a search found, listed: Enter on one shows it in the graph. */
export type SearchMode = { kind: 'search'; query: string; result: SearchResult | null; error: string | null }

/** The search the graph highlights once its list is left: `n` goes to the next. */
export type ActiveSearch = { query: string; hashes: readonly string[]; index: number }

/** The band in place of the keys while a change waits for its confirmation. */
export type Band =
  | { kind: 'preparing'; title: string }
  | { kind: 'confirm'; action: Action }
  /** Several branches at the commit: each choice is its own confirmation. */
  | { kind: 'choose'; title: string; actions: Action[] }
  | { kind: 'tag-form'; commit: Commit; name: string; message: string; error: string | null }
  | { kind: 'search-form'; query: string }
  | { kind: 'running'; action: Action }
  | { kind: 'info'; title: string; lines: string[]; isError: boolean }
  /** One of Claude's commands, held while the person answers whether it runs. */
  | { kind: 'guard'; command: string; lines: string[] }

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
  mode: { kind: 'list' } | DiffMode | { kind: 'journal' } | SessionMode | CompareMode | SearchMode | { kind: 'help' }
  /** A line shown in place of the header until the next action. */
  notice: string | null
  /** The next Escape returns to the prompt without closing the pane. */
  isEscapeKept: boolean
  /** A change being prepared, confirmed or run. */
  action: Band | null
  /** Linear runs folded (`v`), but for the folds opened since. */
  isOverview: boolean
  openedFolds: ReadonlySet<string>
  /** All branches, or one ref's history (`f`). */
  scope: LogScope
  /** Claude's git commands that changed something, newest first. */
  journal: readonly JournalEntry[]
  /** The commit marked to compare another with (`m`). */
  mark: string | null
  search: ActiveSearch | null
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
  isOverview: false,
  openedFolds: new Set(),
  scope: { kind: 'all' },
  journal: [],
  mark: null,
  search: null,
}

/** Rows from the window's end at which the next page starts loading. */
const PREFETCH_ROWS = 15
/** Under the overview, pages load by themselves until the folded rows fill the pane, up to this many commits. */
const AUTO_FILL_COMMITS = 2000
export const REFRESH_DEBOUNCE_MS = 150
const NOTICE_MS = 8000
/** Jumping to a commit past the pages loaded loads this many at a time, up to REVEAL_LIMIT; past it, the commit is shown in focus. */
const REVEAL_PAGE = 1000
const REVEAL_LIMIT = 5000
const PUSH_TIMEOUT_MS = 120_000
const WRITE_TIMEOUT_MS = 30_000

/** The two answers the guard offers. */
export const LET_IT_RUN = 'Laisser passer'
export const REFUSE = 'Refuser'

const shortCommand = (command: string) => (command.length > 120 ? `${command.slice(0, 119)}…` : command)

export type Controller = ReturnType<typeof createController>

export function createController(host: Host) {
  let model: Model = INITIAL
  let windowSize = 20
  let isOpen = false
  let placement: Placement = 'pane'
  let generation = 0
  let pending: { scope: 'all' | 'status'; timer: { cancel: () => void } } | null = null
  let noticeTimer: { cancel: () => void } | null = null
  let running: Promise<void> = Promise.resolve()
  let paging: Promise<void> | null = null

  const set = (patch: Partial<Model>) => {
    model = { ...model, ...patch }
    host.invalidate()
  }

  const repoOf = () => (model.snapshot?.kind === 'repo' ? model.snapshot : null)

  const hasWip = () => (repoOf()?.status.length ?? 0) > 0

  /** A loaded commit, or a stash, by hash. */
  const commitOf = (hash: string | null | undefined): Commit | null => {
    const repo = repoOf()

    if (!repo || !hash) return null

    const stash = repo.stashes.find(one => one.hash === hash)

    return repo.commits.find(one => one.hash === hash) ?? (stash ? stashCommit(stash) : null)
  }

  const itemsOf = (from: Model = model): Item[] =>
    from.view ? flatten(from.view.commits, from.unfolded, from.more, from.view.folds) : []

  /** The view of a snapshot as the model wants it: folded under the overview. */
  const viewOf = (snapshot: RepoSnapshot, from: Model = model): View =>
    buildView(snapshot, from.isOverview ? { opened: from.openedFolds } : null)

  /**
   * The selection carried into new rows: kept when still there, else the
   * fold now holding its commit, else HEAD, else the first row.
   */
  const carried = (items: readonly Item[], view: View, snapshot: RepoSnapshot): string | null => {
    const selected = model.selected

    if (selected === WIP_KEY && snapshot.status.length > 0) return selected
    if (selected && items.some(item => item.key === selected)) return selected

    const hash = selected?.startsWith('c:') ? selected.slice(2) : null
    const fold = hash ? foldHolding(view.folds, hash) : undefined

    if (fold) return foldKey(fold.id)

    const head = snapshot.head.hash

    if (head && items.some(item => item.key === commitKey(head))) return commitKey(head)

    return keyOf(snapshot.status.length > 0 ? -1 : 0, items)
  }

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

      const isSameScope = repo !== null && JSON.stringify(repo.scope) === JSON.stringify(model.scope)
      const count = Math.max(PAGE_SIZE, isSameScope ? repo.commits.length : 0)
      const snapshot = await loadSnapshot(host.git, cwd, { count, baseline, scope: model.scope })

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

    const known = new Set([...snapshot.commits, ...snapshot.stashes].map(commit => commit.hash))
    const unfolded = new Map([...before.unfolded].filter(([under]) => under === WIP ? snapshot.status.length > 0 : known.has(under)))

    if (unfolded.has(WIP)) {
      unfolded.set(WIP, { state: 'loading' })
    }

    const view = viewOf(snapshot)
    const next: Model = {
      ...model,
      snapshot,
      view,
      isLoading: false,
      more: snapshot.hasMore ? 'available' : 'none',
      unfolded,
    }
    const items = itemsOf(next)
    const selected = carried(items, view, snapshot)
    const index = Math.max(0, items.findIndex(item => item.key === selected))

    model = { ...next, selected, top: windowTop(items.length, index, model.top, windowSize) }

    if (model.mode.kind === 'diff' && model.mode.under !== WIP && !known.has(model.mode.under)) {
      model = { ...model, mode: { kind: 'list' } }
    }

    host.invalidate()
    fill()

    if (unfolded.has(WIP)) {
      void unfoldWip()
    }
  }

  /** Under the overview a few folded rows may not fill the pane: load on until they do. */
  const fill = () => {
    const repo = repoOf()

    if (repo && model.isOverview && model.more === 'available' && repo.commits.length < AUTO_FILL_COMMITS && itemsOf().length < windowSize + PREFETCH_ROWS) {
      running = more()
    }
  }

  /** Loads the next page of history (`count` commits). */
  const more = (count?: number): Promise<void> => {
    const repo = repoOf()

    if (!repo || model.more !== 'available') {
      return paging ?? Promise.resolve()
    }

    const ticket = generation

    set({ more: 'loading' })

    paging = (async () => {
      try {
        const next = await loadMore(host.git, repo, count)

        if (ticket === generation) {
          model = { ...model, snapshot: next, view: viewOf(next), more: next.hasMore ? 'available' : 'none' }
          host.invalidate()
          fill()
        }
      } catch {
        set({ more: 'available' })
      } finally {
        paging = null
      }
    })()

    return paging
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

    const commit = commitOf(under)

    if (!commit) {
      return setUnfolded(under, null)
    }

    try {
      setUnfolded(under, { state: 'ready', files: await loadCommitFiles(host.git, repo.repo.toplevel, commit) })
    } catch (error) {
      setUnfolded(under, { state: 'error', message: messageOf(error) })
    }
  }

  /** Shows one file's diff in place of the list (or of the comparison it belongs to). */
  const openDiff = async (under: string, change: FileChange, compare?: CompareMode) => {
    const repo = repoOf()

    if (!repo) {
      return
    }

    const commit = under === WIP ? null : commitOf(under)
    const mode: DiffMode = { kind: 'diff', under, commit, change, diff: { kind: 'loading' }, ...(compare ? { compare } : {}) }

    set({ mode, notice: null, isEscapeKept: false })

    try {
      const diff = compare
        ? await loadRangeDiff(host.git, repo.repo.toplevel, compare.from.hash, compare.to?.hash ?? null, change)
        : commit
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

  /** Leaves a view: a comparison's file for the comparison, the ring back on it; any other for the list. */
  const leave = () => {
    const mode = model.mode

    if (mode.kind === 'diff' && mode.compare) {
      const index = mode.compare.files.state === 'ready' ? mode.compare.files.files.indexOf(mode.change) : -1

      set({ mode: { ...mode.compare, ring: Math.max(0, index) }, notice: null })

      if (index >= 0) void host.focus(`cmp-${index}`).catch(() => undefined)

      return
    }

    set({ mode: { kind: 'list' }, notice: null })
  }

  /** The commit (or stash) of the selected row, or of the file row under it. */
  const selectedCommit = (): Commit | null => {
    const item = itemsOf().find(one => one.key === model.selected)
    const hash = item?.kind === 'commit' ? item.commit.hash : item?.kind === 'file' || item?.kind === 'note' ? item.under : null

    return commitOf(hash)
  }

  /** The selected commit when it is a stash, and the notice for the keys a stash has no use for. */
  const isStashSelected = () => selectedCommit()?.stash !== undefined
  const stashNotice = () => showNotice('Un stash : ⏎ ses fichiers, a pour l’appliquer, e pour l’expliquer', false)

  /**
   * Selects a commit wherever it is: in a fold (opened), past the pages
   * loaded (loaded up to it), out of the history drawn (all branches drawn
   * again, else the commit in focus). The ring follows.
   */
  const reveal = async (hash: string, isRetry = false): Promise<void> => {
    const repo = repoOf()

    if (!repo) return

    const stash = repo.stashes.find(one => one.hash === hash)
    const needed = stash?.base ?? hash
    const isLoaded = () => repoOf()?.commits.some(commit => commit.hash === needed) ?? false
    const loaded = () => repoOf()?.commits.length ?? 0

    // Page on while pages come, the one in flight first.
    for (let before = -1; !isLoaded() && loaded() !== before && loaded() < REVEAL_LIMIT; ) {
      before = loaded()
      await more(REVEAL_PAGE)
    }

    if (!isLoaded()) {
      if (isRetry) return showNotice('Commit introuvable dans l’historique', false)

      const scope: LogScope = model.scope.kind === 'focus' ? { kind: 'all' } : { kind: 'focus', ref: needed, label: needed.slice(0, 7), isFirstParent: false }

      set({ scope })
      running = refresh('all')
      await running
      await reveal(hash, true)

      if (scope.kind === 'focus') {
        showNotice('Commit loin dans l’historique : montré en focus · f pour revenir à toutes les branches', false)
      }

      return
    }

    const fold = model.view ? foldHolding(model.view.folds, hash) : undefined
    const key = commitKey(hash)

    if (fold) {
      rebuild({ openedFolds: new Set([...model.openedFolds, fold.id]) }, key)
    } else {
      const items = itemsOf()

      select(Math.max(0, items.findIndex(item => item.key === key)), items)
    }

    void host.focus(key).catch(() => undefined)
  }

  /** Draws the loaded snapshot again under new view settings, the selection carried. */
  const rebuild = (patch: Partial<Model>, select?: string) => {
    const repo = repoOf()

    model = { ...model, ...patch }

    if (repo) {
      const view = viewOf(repo)
      const items = itemsOf({ ...model, view })
      const selected = select ?? carried(items, view, repo)
      const index = Math.max(0, items.findIndex(item => item.key === selected))

      model = { ...model, view, selected, top: windowTop(items.length, index, model.top, windowSize) }
    }

    host.invalidate()
    fill()
  }

  /** The ref `f` focuses on: the selected commit's branch, remote branch or tag, else the commit. */
  const focusTarget = (): { ref: string; label: string } | null => {
    const commit = selectedCommit()
    const labels = commit ? model.view?.labels.get(commit.hash) ?? [] : []

    for (const label of labels) {
      if (label.kind === 'branch') return { ref: `refs/heads/${label.name}`, label: label.name }
      if (label.kind === 'remote') return { ref: `refs/remotes/${label.name}`, label: label.name }
    }

    for (const label of labels) {
      if (label.kind === 'tag') return { ref: `refs/tags/${label.name}`, label: label.name }
    }

    return commit ? { ref: commit.hash, label: commit.hash.slice(0, 7) } : null
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

  /** The repository's top level, read when no snapshot is loaded (the pane closed). */
  const toplevelOf = async (): Promise<string> => {
    const repo = repoOf()

    if (repo) return repo.repo.toplevel

    const cwd = await host.cwd()
    const info = await host.git(repoInfo(), { cwd })

    return info.code === 0 ? info.stdout.split('\n')[0]?.trim() || cwd : cwd
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
    get placement() {
      return placement
    },

    /** Where the person last chose to see ctree, kept across sessions. */
    async loadPlacement() {
      placement = (await host.store.get(PLACEMENT_KEY)) === 'band' ? 'band' : 'pane'
    },

    /** z: the pane beside the transcript, or the full-width band above the prompt. */
    async zoom() {
      placement = placement === 'pane' ? 'band' : 'pane'
      void host.store.set(PLACEMENT_KEY, placement).catch(() => undefined)

      if (placement === 'band') {
        // Our own close raises no hook of ours: the view stays open, in the band.
        await host.close().catch(() => undefined)
        isOpen = true
        showNotice('Pleine largeur au-dessus du prompt · Ctrl+X Tab (ou un clic) pour piloter · z pour revenir au panneau', false)
      } else {
        isOpen = true
        await host.open(true).catch(() => undefined)
        host.invalidate()
      }
    },
    items: () => itemsOf(),
    selectedIndex: () => indexOf(model.selected, itemsOf()),
    hasWip,
    isStashSelected,

    /** Records which commits the refs point at as the session starts. */
    async recordBaseline() {
      if ((await host.baseline.get()) === null) {
        await host.baseline.set(await loadTips(host.git, await host.cwd()))
      }
    },

    /** /ctree opened the pane, or showed the band: load it afresh. */
    opened() {
      isOpen = true
      host.invalidate()
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

    /** Settles once the last refresh or load, and any it started, has. */
    async idle() {
      let last: Promise<void>

      do {
        last = running
        await last
      } while (last !== running)
    },

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

      if (item.kind === 'fold') {
        // The run opens in place, its newest commit selected.
        const newest = item.fold.commits[0]

        return rebuild(
          { openedFolds: new Set([...model.openedFolds, item.fold.id]), notice: null },
          newest ? commitKey(newest.hash) : undefined,
        )
      }

      select(itemsOf().findIndex(one => one.key === item.key))

      if (item.kind === 'commit') return toggle(item.commit.hash)
      if (item.kind === 'file') return openDiff(item.under, item.change)
    },

    /** q, and Escape in the diff view: back to the list, or to the comparison the file belongs to. */
    back() {
      leave()
    },

    /** l: Claude's git commands this session, each one undoable. */
    openJournal() {
      set({ mode: { kind: 'journal' }, notice: null, isEscapeKept: false })
    },

    /** s: what this conversation changed, from where the refs stood when it started. */
    async openSession() {
      const mode: SessionMode = { kind: 'session', data: null, error: null }

      set({ mode, notice: null, isEscapeKept: false })

      try {
        const toplevel = await toplevelOf()
        const now = await readRefState(host.git, toplevel)
        let start = await host.start.get()

        if (!now) throw new Error('pas de dépôt git ici')

        if (!start) {
          start = { ...now, at: await host.now() }
          await host.start.set(start)
        }

        const data = await loadSessionData(host.git, toplevel, start, now, repoOf()?.sessionCommits ?? [])

        if (model.mode === mode) set({ mode: { ...mode, data } })
      } catch (error) {
        if (model.mode === mode) set({ mode: { ...mode, error: messageOf(error) } })
      }
    },

    /** The journal as it was kept, after a reload or at the session's start. */
    async loadJournal() {
      model = { ...model, journal: [...((await host.journal.get()) ?? [])] }
    },

    /** Where every ref stands as the session starts, for the session view. */
    async recordStart() {
      if ((await host.start.get()) === null) {
        const now = await readRefState(host.git, await toplevelOf())

        if (now) await host.start.set({ ...now, at: await host.now() })
      }
    },

    /**
     * Before one of Claude's shell commands runs: when a git command in it
     * would lose something, the band and Claude Code's question dialog say
     * what, and the command waits for the person. Resolves the refusal Claude
     * reads, or, when it runs and throws tracked changes away, their copy.
     */
    async guard(command: string): Promise<{ deny?: string; saved?: { hash: string; files: number } }> {
      const risky = gitCalls(command).flatMap(call => {
        const risk = riskOf(call)

        return risk ? [{ call, risk }] : []
      })

      if (risky.length === 0) return {}

      const toplevel = await toplevelOf()
      const [status, symbolic] = await Promise.all([readStatus(host.git, toplevel), host.git(headRef(), { cwd: toplevel })])
      const branch = symbolic.code === 0 ? symbolic.stdout.trim().replace(/^refs\/heads\//, '') || null : null
      const lines: string[] = []

      for (const { call, risk } of risky) {
        lines.push(
          ...(call.isElsewhere
            ? [`dans un autre dépôt (${call.text}) : ce qu’elle perd n’a pas été vérifié`]
            : await consequences(host.git, risk, { toplevel, status, branch }).catch(() => [`${call.text} : ce qu’elle perd n’a pas pu être vérifié`])),
        )
      }

      if (lines.length === 0) return {}

      const shown = shortCommand(risky.map(one => one.call.text).join(' ; '))
      const held = model.action
      const question = `Claude veut lancer « ${shown} ». ${lines.join(' ; ')}. Laisser passer ?`
      let answer: string | null = null

      set({ action: { kind: 'guard', command: shown, lines } })

      try {
        answer = await host.ask(question.length > 600 ? `${question.slice(0, 590)}… Laisser passer ?` : question, [LET_IT_RUN, REFUSE])
      } finally {
        set({ action: held })
      }

      if (answer !== LET_IT_RUN) {
        return {
          deny:
            `ctree : la personne a refusé « ${shown} », qui aurait perdu : ${lines.join(' ; ')}. ` +
            'Ne relance pas cette commande telle quelle : demande-lui comment procéder.',
        }
      }

      const tracked = status.filter(entry => entry.code !== '?')

      if (risky.some(one => losesChanges(one.risk)) && tracked.length > 0) {
        const created = await host.write(['stash', 'create'], { cwd: toplevel }).catch(() => null)
        const hash = created?.code === 0 ? created.stdout.trim() : ''

        if (/^[0-9a-f]{40,64}$/.test(hash)) return { saved: { hash, files: tracked.length } }
      }

      return {}
    },

    /** Where the refs stand before one of Claude's git commands; null outside a repository. */
    async watch(): Promise<RefState | null> {
      return readRefState(host.git, await toplevelOf()).catch(() => null)
    },

    /** After it: a journal entry when it moved refs or threw changes away. */
    async record(command: string, before: RefState, input: { saved?: { hash: string; files: number }; isSubagent: boolean }) {
      const after = await readRefState(host.git, await toplevelOf()).catch(() => null)

      if (!after) return

      const entry = journalEntry({
        at: await host.now(),
        turn: await host.turns().catch(() => 0),
        command,
        isSubagent: input.isSubagent,
        before,
        after,
        ...(input.saved ? { saved: input.saved } : {}),
      })

      if (!entry) return

      const journal = appended(model.journal, entry)

      set({ journal })
      await host.journal.set(journal)
    },

    /** u: undo a journal entry (the latest not undone when none is named), confirmed first. */
    async beginUndo(id?: string) {
      const entry = id ? model.journal.find(one => one.id === id) : model.journal.find(one => !one.isUndone)

      if (!entry) return showNotice('Rien à annuler : Claude n’a encore rien changé avec git', false)
      if (entry.isUndone) return showNotice('Déjà annulé', false)

      const now = await readRefState(host.git, await toplevelOf())

      if (!now) return

      const plan = undoPlan(entry, now)
      const command = shortCommand(entry.command)
      const title = `⟲ Annuler « ${command} » (tour ${entry.turn})`
      const what = describeMoves(entry).join(', ')
      const note = (extra: string) =>
        `[ctree] Via le panneau, la personne a annulé ta commande « ${command} » (tour ${entry.turn}) : ${what}${extra}. ` +
        'Le dépôt est revenu à l’état d’avant cette commande.'
      const base = { kind: 'undo' as const, title, confirm: 'défaire', undoes: entry.id }
      const actions: Action[] = []
      const [first, ...rest] = plan.steps

      if (first) {
        actions.push({ ...base, args: first, then: rest, details: plan.notes, success: '✓ Annulé', note: note('') })
      }

      if (plan.restore) {
        const [head, ...tail] = [...plan.steps, plan.restore]

        actions.push({
          ...base,
          title: first ? `${title}, fichiers compris` : `⟲ Récupérer les fichiers jetés par « ${command} »`,
          args: head ?? plan.restore,
          then: tail,
          details: [`récupère ${entry.savedFiles ?? 0} fichier(s) modifié(s) jeté(s) (git stash apply)`, ...plan.notes],
          success: '✓ Annulé, fichiers récupérés',
          note: note(', et les fichiers modifiés jetés sont revenus'),
        })
      }

      const [only] = actions

      if (!only) {
        return openBand({ kind: 'info', title, lines: plan.notes.length ? plan.notes : ['plus rien à remettre'], isError: false }, 'act-n')
      }

      openBand(actions.length === 1 ? { kind: 'confirm', action: only } : { kind: 'choose', title, actions }, 'act-n')
    },

    /** q: closes the pane. Our own close raises no hook of ours, so say it here. */
    async close() {
      if (placement === 'pane') {
        await host.close()
      }

      closed()
      host.invalidate()
    },

    /** e: a question about the selected row, put in the prompt, not sent. */
    async explain() {
      const repo = repoOf()

      if (!repo) {
        return
      }

      const text =
        model.mode.kind === 'session'
          ? model.mode.data && prDescriptionPrompt(model.mode.data)
          : promptFor(model, commitOf, itemsOf(), repo.status.length)

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

    /** v: folds linear runs (or unfolds them all), the selection kept in sight. */
    toggleOverview() {
      rebuild({ isOverview: !model.isOverview, openedFolds: new Set(), notice: null, isEscapeKept: false })
    },

    /**
     * f: all branches → the selected branch's history → its first parents
     * alone → all branches again. The log is read again for each.
     */
    cycleFocus() {
      const scope = model.scope
      let next: LogScope = { kind: 'all' }

      if (scope.kind === 'all') {
        if (isStashSelected()) return stashNotice()

        const target = focusTarget()

        if (!target || !(isSafeRefName(target.ref) || /^[0-9a-f]{40,64}$/.test(target.ref))) {
          return showNotice('Sélectionne un commit ou une branche à suivre', false)
        }

        next = { kind: 'focus', ...target, isFirstParent: false }
      } else if (!scope.isFirstParent) {
        next = { ...scope, isFirstParent: true }
      }

      set({ scope: next, notice: null, isEscapeKept: false })
      running = refresh('all')
    },

    /** h: every key, and what the graph's marks mean. */
    openHelp() {
      set({ mode: { kind: 'help' }, notice: null, isEscapeKept: false })
    },

    /** i: back to HEAD, wherever the list was scrolled to. */
    async jumpHead() {
      const head = repoOf()?.head.hash

      if (!head) return showNotice('Pas encore de commit', false)

      await reveal(head)
    },

    /** y: the selected commit's full hash on the clipboard. */
    async copyHash() {
      const commit = selectedCommit()

      if (!commit) return showNotice('Sélectionne un commit pour copier son hash', false)

      const isCopied = await host.copy(commit.hash).catch(() => false)

      showNotice(isCopied ? `✓ Copié : ${commit.hash}` : 'Le presse-papiers n’a rien pris ici', false)
    },

    /** m: marks the selected commit to compare another with, or takes the mark off. */
    toggleMark() {
      const commit = selectedCommit()

      if (!commit) return showNotice('Sélectionne un commit à marquer', false)

      if (model.mark === commit.hash) {
        set({ mark: null })
        return showNotice('Marque retirée', false)
      }

      set({ mark: commit.hash })
      showNotice(`⚑ ${commit.hash.slice(0, 7)} marqué · sélectionne un autre commit, puis d pour comparer`, false)
    },

    /** d: the selected commit (or the uncommitted changes) compared with the mark, else with HEAD. */
    async beginCompare() {
      const repo = repoOf()

      if (!repo) return

      const isWip = model.selected === WIP_KEY
      const selected = isWip ? null : selectedCommit()
      const base = commitOf(model.mark ?? repo.head.hash)
      const howTo = 'Marque un commit avec m, puis d sur un autre pour les comparer'

      if (!isWip && !selected) return showNotice('Sélectionne un commit à comparer', false)
      if (!base) return showNotice(model.mark ? 'Le commit marqué n’est plus dans le graphe' : howTo, false)
      if (selected?.hash === base.hash) return showNotice(model.mark ? 'Sélectionne un autre commit que la marque, puis d' : howTo, false)

      // The older first, so the comparison reads forward.
      const [from, to] = selected && selected.time < base.time ? [selected, base] : [base, selected]
      const mode: CompareMode = { kind: 'compare', from, to, files: { state: 'loading' }, counts: null, ring: 0 }
      const toplevel = repo.repo.toplevel
      const count = async (a: string, b: string) => {
        const result = await host.git(countRange(a, b), { cwd: toplevel })

        return result.code === 0 ? Number(result.stdout.trim()) || 0 : null
      }

      set({ mode, notice: null, isEscapeKept: false })

      try {
        const [files, ahead, behind] = await Promise.all([
          loadRangeFiles(host.git, toplevel, from.hash, to?.hash ?? null),
          to ? count(from.hash, to.hash) : null,
          to ? count(to.hash, from.hash) : null,
        ])

        if (model.mode === mode) {
          set({ mode: { ...mode, files: { state: 'ready', files }, counts: ahead !== null && behind !== null ? { ahead, behind } : null } })

          // The ring onto the first file: Enter opens it.
          if (files.length > 0) void host.focus('cmp-0').catch(() => undefined)
        }
      } catch (error) {
        if (model.mode === mode) set({ mode: { ...mode, files: { state: 'error', message: messageOf(error) } } })
      }
    },

    /** Enter on a file of the comparison: its diff from one commit to the other. */
    openCompareFile(index: number) {
      const mode = model.mode

      if (mode.kind !== 'compare' || mode.files.state !== 'ready') return

      const change = mode.files.files[index]

      if (change) void openDiff(mode.to?.hash ?? WIP, change, mode)
    },

    /** g: the search field, holding the last search. */
    beginSearch() {
      if (!repoOf()) return

      openBand({ kind: 'search-form', query: model.search?.query ?? '' }, 'search-query')
    },

    /** What the person types in the search field; not drawn again. */
    setSearchQuery(value: string) {
      const band = model.action

      if (band?.kind === 'search-form') model = { ...model, action: { ...band, query: value } }
    },

    /** Enter in the search field: the history searched, what it found listed. */
    async submitSearch(value?: string) {
      const repo = repoOf()
      const band = model.action

      if (!repo || band?.kind !== 'search-form') return

      const query = (value ?? band.query).trim()

      if (!query) return closeBand()

      const mode: SearchMode = { kind: 'search', query, result: null, error: null }

      model = { ...model, action: null }
      set({ mode, notice: null, isEscapeKept: false })

      try {
        const result = await search(host.git, repo, query)

        if (model.mode !== mode) return

        set({ mode: { ...mode, result }, search: { query, hashes: result.hits.map(hit => hit.commit.hash), index: -1 } })

        const first = result.hits[0]

        if (first) void host.focus(`hit-${first.commit.hash}`).catch(() => undefined)
      } catch (error) {
        if (model.mode === mode) set({ mode: { ...mode, error: messageOf(error) } })
      }
    },

    /** Enter on a result: the graph again, that commit selected. */
    async openHit(hash: string) {
      const search = model.search

      set({ mode: { kind: 'list' }, ...(search ? { search: { ...search, index: search.hashes.indexOf(hash) } } : {}) })
      await reveal(hash)
    },

    /** n: the search's next result, in the graph. */
    async nextHit() {
      const search = model.search

      if (!search || search.hashes.length === 0) return showNotice('Aucune recherche en cours : g pour chercher', false)

      const index = (search.index + 1) % search.hashes.length
      const hash = search.hashes[index]

      set({ search: { ...search, index } })

      if (hash) await reveal(hash)
    },

    /** a: the selected stash applied to the working tree, once confirmed. */
    beginApplyStash() {
      const repo = repoOf()
      const commit = selectedCommit()
      const stash = repo?.stashes.find(one => one.hash === commit?.hash)

      if (!repo) return
      if (!stash) return showNotice('Sélectionne un stash (≡) pour l’appliquer', false)

      openBand({ kind: 'confirm', action: applyStashAction(stash, repo.status.length) }, 'act-n')
    },

    /** c: switch to the selected commit's branch (a choice when it has several). */
    beginSwitch() {
      const repo = repoOf()
      const commit = selectedCommit()

      if (!repo) return
      if (!commit) return showNotice('Sélectionne un commit pour changer de branche', false)
      if (commit.stash) return stashNotice()

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
      if (commit.stash) return stashNotice()

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
        const steps = [action.args, ...(action.then ?? [])]

        for (const [i, args] of steps.entries()) {
          const result = await host.write(args, { cwd: toplevel, env, timeoutMs })

          if (result.code !== 0) {
            const done = i > 0 ? [`${i} étape${i > 1 ? 's' : ''} sur ${steps.length} faite${i > 1 ? 's' : ''} avant : ${displayCommand(args)} a échoué`] : []

            openBand({ kind: 'info', title: `✗ ${action.title}`, lines: [...errorLines(result), ...done], isError: true }, 'act-n')
            await refresh('all')
            return
          }
        }

        if (action.undoes) {
          const journal = model.journal.map(entry => (entry.id === action.undoes ? { ...entry, isUndone: true as const } : entry))

          model = { ...model, journal }
          await host.journal.set(journal)
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
      if (model.action && model.action.kind !== 'running' && model.action.kind !== 'guard') {
        closeBand()
      }
    },

    /** Escape was pressed: whether it closes the pane, or is spent on going back. */
    escape(): 'close' | 'back' | 'keep' {
      if (model.action) {
        if (model.action.kind !== 'running' && model.action.kind !== 'guard') {
          closeBand()
        }

        return 'back'
      }

      if (model.mode.kind !== 'list') {
        leave()
        return 'back'
      }

      // The search's highlight goes first.
      if (model.search) {
        set({ search: null, notice: null })
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

/** The question for the selected row, or for the file the diff view shows, or the comparison. */
function promptFor(
  model: Model,
  commitOf: (hash: string) => Commit | null,
  items: readonly Item[],
  wipCount: number,
): string | null {
  if (model.mode.kind === 'diff') {
    const { commit, change, compare } = model.mode

    if (compare) return explainComparePrompt(compare.from, compare.to, change.path)

    return commit ? explainFilePrompt(commit, change.path) : explainWipPrompt(wipCount, change.path)
  }

  if (model.mode.kind === 'compare') {
    return explainComparePrompt(model.mode.from, model.mode.to)
  }

  if (model.mode.kind !== 'list') {
    return null
  }

  if (model.selected === WIP_KEY) {
    return explainWipPrompt(wipCount)
  }

  const item = items.find(one => one.key === model.selected)

  if (!item) return null
  if (item.kind === 'commit') return item.commit.stash ? explainStashPrompt(item.commit) : explainCommitPrompt(item.commit)
  if (item.kind === 'fold') return explainRangePrompt(item.fold)

  if (item.kind === 'file') {
    const commit = commitOf(item.under)

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
