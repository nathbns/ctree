// The pane's list as a flat sequence of rows (commits and the files of the
// unfolded ones), the window of it the pane shows, and what a move of the
// focus ring means for the selection.

import type { Fold } from './overview'
import { WIP } from './rows'
import type { Commit, FileChange } from './types'

/** What an unfolded commit (or the uncommitted changes) shows under it. */
export type Unfolded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; files: readonly FileChange[] }

export type Item =
  | { kind: 'commit'; key: string; commit: Commit }
  | { kind: 'fold'; key: string; fold: Fold }
  | { kind: 'file'; key: string; under: string; index: number; change: FileChange }
  | { kind: 'note'; key: string; under: string; text: string }

export const WIP_KEY = 'wip'

export const commitKey = (hash: string): string => `c:${hash}`

export const fileKey = (under: string, index: number): string => `f:${under}:${index}`

export const foldKey = (id: string): string => `z:${id}`

/**
 * The rows below the pinned uncommitted-changes row, in drawing order:
 * `commits` as the view draws them, a fold in place of each folded run.
 */
export function flatten(
  commits: readonly Commit[],
  unfolded: ReadonlyMap<string, Unfolded>,
  more: 'none' | 'available' | 'loading',
  folds: ReadonlyMap<string, Fold> = new Map(),
): Item[] {
  const items: Item[] = []

  const filesOf = (under: string) => {
    const open = unfolded.get(under)

    if (!open) {
      return
    }

    if (open.state === 'loading') {
      items.push({ kind: 'note', key: `n:${under}`, under, text: 'chargement…' })
    } else if (open.state === 'error') {
      items.push({ kind: 'note', key: `n:${under}`, under, text: `erreur : ${open.message}` })
    } else if (open.files.length === 0) {
      items.push({ kind: 'note', key: `n:${under}`, under, text: 'aucun fichier modifié' })
    } else {
      open.files.forEach((change, index) => {
        items.push({ kind: 'file', key: fileKey(under, index), under, index, change })
      })
    }
  }

  filesOf(WIP)

  for (const commit of commits) {
    const fold = folds.get(commit.hash)

    if (fold) {
      items.push({ kind: 'fold', key: foldKey(fold.id), fold })
      continue
    }

    items.push({ kind: 'commit', key: commitKey(commit.hash), commit })
    filesOf(commit.hash)
  }

  if (more === 'loading') {
    const last = commits[commits.length - 1]

    items.push({ kind: 'note', key: 'n:more', under: last?.hash ?? WIP, text: 'chargement des commits suivants…' })
  }

  return items
}

/**
 * The first row the window shows, moved as little as possible so the
 * selection keeps `margin` rows of context above and below.
 */
export function windowTop(total: number, selected: number, top: number, size: number, margin = 2): number {
  if (size <= 0 || total <= size) {
    return 0
  }

  const room = Math.min(margin, Math.floor((size - 1) / 2))
  let next = top

  if (selected >= 0 && selected < next + room) {
    next = selected - room
  }

  if (selected > next + size - 1 - room) {
    next = selected - (size - 1 - room)
  }

  return Math.max(0, Math.min(next, total - size))
}

/** What a move of the focus ring the person made means for the list. */
export type FocusMove =
  | { kind: 'select'; index: number }
  /** The ring would wrap past an end: keep it where it is. */
  | { kind: 'stay'; isAtEnd: boolean }
  /** The ring goes to a control that is not a row: leave the selection. */
  | { kind: 'pass' }

/**
 * Reads a ring move from the selected row to the element keyed `target`.
 * Rows are indexed in `items`; the pinned uncommitted row is index -1.
 */
export function focusMove(input: {
  items: readonly Item[]
  hasWip: boolean
  selected: number
  target: string | undefined
  top: number
  size: number
}): FocusMove {
  const { items, hasWip, selected, top, size } = input
  const first = hasWip ? -1 : 0
  const lastDrawn = Math.min(items.length, top + size) - 1
  const last = items.length - 1
  const index = input.target === WIP_KEY ? -1 : items.findIndex(item => item.key === input.target)
  const isRow = index >= 0 || (index === -1 && input.target === WIP_KEY && hasWip)

  if (!isRow) {
    const isAtEdge = selected === last || selected === first

    return isAtEdge ? { kind: 'stay', isAtEnd: selected === last } : { kind: 'pass' }
  }

  const firstDrawn = hasWip ? -1 : top
  const isFar = lastDrawn - firstDrawn >= 2
  const wrapsDown = isFar && selected === lastDrawn && index === firstDrawn
  const wrapsUp = isFar && selected === firstDrawn && index === lastDrawn

  if (wrapsDown || wrapsUp) {
    return { kind: 'stay', isAtEnd: wrapsDown }
  }

  return { kind: 'select', index }
}

/** The next selectable row from `index` in `direction`, skipping notes. */
export function step(items: readonly Item[], hasWip: boolean, index: number, direction: 1 | -1): number {
  const first = hasWip ? -1 : 0
  let next = index + direction

  while (next >= 0 && next < items.length && items[next]?.kind === 'note') {
    next += direction
  }

  if (next < first) return first
  if (next >= items.length) return index

  return next
}
