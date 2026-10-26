// Rows of the pane as runs of styled text: the pure half of the drawing.
// The hooks module turns each run into a `Text` and each row into a `Button`.

import { colorPaths, DASHED_COLOR, HEAD_COLOR, TAG_COLOR } from './colors'
import { absoluteDate, counts, relativeDate, shortAuthor, shortHash, statusLetter } from './format'
import { computeGraph, glyphOf, type Graph } from './lanes'
import { labelsByCommit, labelText, refsByCommit, type Label } from './labels'
import {
  AUTHOR_WIDTH,
  type Columns,
  DATE_WIDTH,
  GAP,
  padEnd,
  padStart,
  sideWidth,
  textWidth,
  truncate,
  truncateStart,
} from './layout'
import type { Commit, FileChange, RepoSnapshot } from './types'

export type Segment = {
  text: string
  color?: string
  bold?: true
  italic?: true
  dim?: true
  inverse?: true
}

/** The pseudo-commit standing for the uncommitted changes in the graph. */
export const WIP = 'WIP'

/** What every row of one snapshot is drawn from, computed once per snapshot. */
export type View = {
  graph: Graph
  colors: string[]
  labels: Map<string, Label[]>
  /** Graph row of each commit (and of WIP). */
  rowOf: Map<string, number>
  head: string | null
  session: Set<string>
}

export function buildView(snapshot: RepoSnapshot): View {
  const head = snapshot.head.hash
  const hasWip = snapshot.status.length > 0
  const input = [
    ...(hasWip ? [{ hash: WIP, parents: head ? [head] : [] }] : []),
    ...snapshot.commits,
  ]
  const graph = computeGraph(input, { dashed: WIP })

  return {
    graph,
    colors: colorPaths(graph, refsByCommit(snapshot.refs), head),
    labels: labelsByCommit({
      refs: snapshot.refs,
      head: snapshot.head,
      worktrees: snapshot.worktrees,
      toplevel: snapshot.repo.toplevel,
    }),
    rowOf: new Map(input.map((commit, row) => [commit.hash, row])),
    head,
    session: new Set(snapshot.sessionCommits),
  }
}

/** One graph cell or gap, before styling. */
type Cell = { char: string; color?: string }

/** The cells of a commit's row, two per lane. */
function rowCells(view: View, row: number, node: string): Cell[] {
  const graphRow = view.graph.rows[row]

  if (!graphRow) {
    return []
  }

  const cells: Cell[] = []

  graphRow.cells.forEach((cell, lane) => {
    const owner = cell.isNode ? graphRow.path : cell.hPath ?? cell.vPath
    const isDashed = cell.hPath === undefined && cell.vPath !== undefined && view.graph.paths[cell.vPath]?.isDashed === true

    cells.push({
      char: cell.isNode ? node : glyphOf(cell.dirs, isDashed),
      color: owner === undefined ? undefined : view.colors[owner],
    })

    const gap = graphRow.gaps[lane]

    cells.push(gap === undefined ? { char: ' ' } : { char: '─', color: view.colors[gap] })
  })

  return trimCells(cells)
}

/** The cells drawn under a row (its file list): every lane that runs on. */
function belowCells(view: View, row: number): Cell[] {
  const graphRow = view.graph.rows[row]
  const cells: Cell[] = []

  for (const path of graphRow?.below ?? []) {
    const isDashed = path !== null && view.graph.paths[path]?.isDashed === true

    cells.push(
      path === null ? { char: ' ' } : { char: isDashed ? '┊' : '│', color: view.colors[path] },
      { char: ' ' },
    )
  }

  return trimCells(cells)
}

function trimCells(cells: Cell[]): Cell[] {
  while (cells.length > 0 && cells[cells.length - 1]?.char === ' ') {
    cells.pop()
  }

  return cells
}

/** How wide the graph column is for these rows: their widest, within `limit`. */
export function graphWidthOf(view: View, rows: readonly number[], limit: number): number {
  let widest = 1

  for (const row of rows) {
    widest = Math.max(widest, rowCells(view, row, '●').length, belowCells(view, row).length)
  }

  return Math.min(widest, limit)
}

/** Fits cells into `width` columns, keeping the node visible past the cut. */
function fitCells(cells: Cell[], width: number, nodeAt: number): Cell[] {
  if (cells.length <= width) {
    return [...cells, ...Array.from({ length: width - cells.length }, () => ({ char: ' ' }))]
  }

  const more = { char: '…', color: 'inactive' }

  if (nodeAt < 0 || nodeAt < width - 1) {
    return [...cells.slice(0, width - 1), more]
  }

  const node = cells[nodeAt] ?? { char: '●' }

  return [...cells.slice(0, Math.max(0, width - 2)), more, node].slice(0, width)
}

/** Cells merged into runs of one colour. */
function cellSegments(cells: readonly Cell[]): Segment[] {
  const out: Segment[] = []

  for (const cell of cells) {
    const last = out[out.length - 1]

    if (last && last.color === cell.color) {
      last.text += cell.char
    } else {
      out.push(cell.color ? { text: cell.char, color: cell.color } : { text: cell.char })
    }
  }

  return out
}

export type LineOptions = {
  /** Columns of the whole row. */
  width: number
  /** Columns of the graph, from graphWidthOf. */
  graphWidth: number
  columns: Columns
  isSelected: boolean
  /** Milliseconds since the epoch, for relative dates. */
  now: number
}

function pointer(isSelected: boolean): Segment {
  return isSelected ? { text: '❯ ', color: 'claude', bold: true } : { text: '  ' }
}

export function nodeGlyph(view: View, commit: Commit): string {
  if (commit.hash === view.head) return '◉'

  return commit.parents.length > 1 ? '○' : '●'
}

/** A commit's row: graph, message, labels, author, date, hash. */
export function commitLine(view: View, commit: Commit, options: LineOptions): Segment[] {
  const row = view.rowOf.get(commit.hash) ?? -1
  const color = view.colors[view.graph.rows[row]?.path ?? -1]
  const lane = view.graph.rows[row]?.lane ?? -1
  const graph = fitCells(rowCells(view, row, nodeGlyph(view, commit)), options.graphWidth, lane * 2)
  const area = Math.max(4, options.width - 2 - options.graphWidth - 1 - sideWidth(options.columns))
  const isSession = view.session.has(commit.hash)
  const chips = fitLabels(view.labels.get(commit.hash) ?? [], color, labelBudget(area))
  const chipsWidth = chips.reduce((sum, chip) => sum + textWidth(chip.text), 0)
  const messageRoom = Math.max(1, area - chipsWidth - (chipsWidth > 0 ? 1 : 0) - (isSession ? 2 : 0))
  const subject = truncate(commit.subject || '(sans message)', messageRoom)
  const used = (isSession ? 2 : 0) + textWidth(subject) + chipsWidth

  return merge([
    pointer(options.isSelected),
    ...cellSegments(graph),
    { text: ' ' },
    ...(isSession ? [{ text: '✦ ', color: 'claude' }] : []),
    commit.subject ? { text: subject } : { text: subject, dim: true },
    { text: ' '.repeat(Math.max(chipsWidth > 0 ? 1 : 0, area - used)) },
    ...chips,
    ...sideSegments(commit, options),
  ])
}

/** The pinned row of uncommitted changes. */
export function wipLine(view: View, count: number, options: LineOptions): Segment[] {
  const row = view.rowOf.get(WIP) ?? -1
  const graph = fitCells(rowCells(view, row, '◌'), options.graphWidth, 0)
  const text = `Modifications non commitées (${count})`

  return merge([
    pointer(options.isSelected),
    ...cellSegments(graph).map(segment => ({ ...segment, color: segment.color ?? DASHED_COLOR })),
    { text: ' ' },
    { text: truncate(text, Math.max(4, options.width - 3 - options.graphWidth)), bold: true },
  ])
}

/** A file under an unfolded commit (or under the uncommitted changes). */
export function fileLine(view: View, under: string, change: FileChange, options: LineOptions): Segment[] {
  const row = view.rowOf.get(under) ?? -1
  const graph = fitCells(belowCells(view, row), options.graphWidth, -1)
  const letter = statusLetter(change.status)
  const amount = counts(change.added, change.deleted)
  const room = Math.max(4, options.width - 2 - options.graphWidth - 1 - 4 - textWidth(amount) - 2)
  const name = truncateStart(change.oldPath ? `${change.oldPath} → ${change.path}` : change.path, room)
  const gap = Math.max(1, options.width - 2 - options.graphWidth - 1 - 4 - textWidth(name) - textWidth(amount))
  const [added, deleted] = amount.split(' ')

  return merge([
    pointer(options.isSelected),
    ...cellSegments(graph),
    { text: '   ' },
    { text: letter, color: statusColor(letter), bold: true },
    { text: ` ${name}` },
    { text: ' '.repeat(gap) },
    ...(amount === 'binaire'
      ? [{ text: amount, dim: true } as Segment]
      : [
          ...(added ? [{ text: added, color: added.startsWith('+') ? 'success' : 'error' }] : []),
          ...(deleted ? [{ text: ` ${deleted}`, color: 'error' }] : []),
        ]),
  ])
}

/** A dim note under a row: loading, an error, nothing changed. */
export function noteLine(view: View, under: string, text: string, options: LineOptions): Segment[] {
  const row = view.rowOf.get(under) ?? -1
  const graph = fitCells(belowCells(view, row), options.graphWidth, -1)

  return merge([
    pointer(options.isSelected),
    ...cellSegments(graph),
    { text: '   ' },
    { text: truncate(text, Math.max(4, options.width - 6 - options.graphWidth)), dim: true },
  ])
}

/** The line above the graph: repository, branch, how it stands against its upstream. */
export function headerLine(snapshot: RepoSnapshot, width: number): Segment[] {
  const parts: Segment[][] = [[{ text: snapshot.repo.name, bold: true }]]
  const head = snapshot.head

  if (head.kind === 'detached') {
    parts.push([{ text: `HEAD détachée @ ${shortHash(head.hash)}`, color: 'warning', bold: true }])
  } else {
    parts.push([{ text: `⎇ ${head.branch}`, color: HEAD_COLOR, bold: true }])

    const branch = snapshot.refs.find(ref => ref.kind === 'branch' && ref.name === head.branch)

    if (head.hash === null) {
      parts.push([{ text: 'aucun commit', dim: true }])
    } else if (branch?.upstream && branch.isUpstreamGone) {
      parts.push([{ text: `${branch.upstream} supprimée`, color: 'warning' }])
    } else if (branch?.upstream) {
      const [ahead, behind] = branch.track ?? [0, 0]
      const sync = ahead === 0 && behind === 0 ? '✓' : [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ')

      parts.push([{ text: `${sync} ${branch.upstream}`, dim: true }])
    }
  }

  if (snapshot.repo.isLinkedWorktree) {
    parts.push([{ text: 'worktree secondaire', color: 'warning' }])
  }

  if (snapshot.sessionCommits.length > 0) {
    parts.push([{ text: `✦ ${snapshot.sessionCommits.length} cette session`, color: 'claude' }])
  }

  return fitParts(parts, width - 1)
}

/** The question `e` puts in the prompt for a commit. */
export function explainCommitPrompt(commit: Commit): string {
  const kind = commit.parents.length > 1 ? 'le merge' : 'le commit'

  return (
    `Explique ${kind} ${shortHash(commit.hash)} « ${commit.subject} » ` +
    `(${commit.author}, ${absoluteDate(commit.time)} UTC) : ce qu'il change, pourquoi, ` +
    `et ce qu'il faut surveiller. Lis-le avec git show ${shortHash(commit.hash)}.`
  )
}

export function explainFilePrompt(commit: Commit, path: string): string {
  return (
    `Explique les changements de ${path} dans le commit ${shortHash(commit.hash)} ` +
    `« ${commit.subject} » : ce qu'ils font et pourquoi. ` +
    `Lis-les avec git show ${shortHash(commit.hash)} -- ${path}.`
  )
}

export function explainWipPrompt(count: number, path?: string): string {
  return path
    ? `Explique mes modifications non commitées de ${path} (git diff HEAD -- ${path}) : ce qu'elles changent et s'il manque quelque chose.`
    : `Explique mes ${count} modifications non commitées (git status, git diff HEAD) : ce qu'elles changent et s'il manque quelque chose avant de committer.`
}

function sideSegments(commit: Commit, options: LineOptions): Segment[] {
  const out: Segment[] = []
  const gap = ' '.repeat(GAP)

  if (options.columns.author) {
    out.push({ text: gap + padEnd(truncate(shortAuthor(commit.author), AUTHOR_WIDTH), AUTHOR_WIDTH), dim: true })
  }

  if (options.columns.date) {
    out.push({ text: gap + padStart(relativeDate(commit.time, options.now), DATE_WIDTH), dim: true })
  }

  if (options.columns.hash) {
    out.push({ text: gap + shortHash(commit.hash), dim: true })
  }

  return out
}

/** At most half of the message area, never less than 12 columns. */
function labelBudget(area: number): number {
  return Math.min(area - 4, Math.max(12, Math.floor(area / 2)))
}

function chipOf(label: Label, color: string | undefined): Segment {
  const text = labelText(label)

  switch (label.kind) {
    case 'branch':
      return label.isHead
        ? { text: ` ${text} `, color: color ?? HEAD_COLOR, inverse: true, bold: true }
        : { text, color, bold: true }
    case 'remote':
      return { text, color, italic: true }
    case 'tag':
      return { text, color: TAG_COLOR }
    case 'detached':
      return { text: ` ${text} `, color: 'warning', inverse: true, bold: true }
  }
}

/**
 * The chips that fit in `budget` columns, one space apart; the first is cut
 * rather than dropped, the rest dropped and counted (`+2`).
 */
function fitLabels(labels: readonly Label[], color: string | undefined, budget: number): Segment[] {
  const out: Segment[] = []
  let used = 0

  for (const [i, label] of labels.entries()) {
    const chip = chipOf(label, color)
    const sep = out.length > 0 ? 1 : 0
    const left = labels.length - i - 1
    const reserve = left > 0 ? 3 : 0

    if (used + sep + textWidth(chip.text) + reserve <= budget) {
      if (sep) out.push({ text: ' ' })
      out.push(chip)
      used += sep + textWidth(chip.text)
      continue
    }

    if (out.length === 0) {
      out.push({ ...chip, text: truncate(chip.text, Math.max(4, budget - reserve)) })
      used += textWidth(out[0]?.text ?? '')

      if (left > 0) {
        out.push({ text: ` +${left}`, dim: true })
      }

      return out
    }

    out.push({ text: ` +${labels.length - i}`, dim: true })

    return out
  }

  return out
}

function statusColor(letter: string): string {
  switch (letter) {
    case 'A':
    case 'U':
      return 'success'
    case 'D':
    case '!':
      return 'error'
    case 'R':
    case 'C':
      return HEAD_COLOR
    default:
      return 'warning'
  }
}

/** Parts joined by ` · `, the last ones dropped when they do not fit. */
function fitParts(parts: readonly Segment[][], width: number): Segment[] {
  const out: Segment[] = []
  let used = 0

  for (const part of parts) {
    const sep = out.length > 0 ? 3 : 0
    const partWidth = part.reduce((sum, segment) => sum + textWidth(segment.text), 0)

    if (used + sep + partWidth > width) {
      if (out.length === 0) {
        out.push(...part.map(segment => ({ ...segment, text: truncate(segment.text, width) })))
      }

      break
    }

    if (sep) out.push({ text: ' · ', dim: true })
    out.push(...part)
    used += sep + partWidth
  }

  return merge(out)
}

/** Adjacent segments of one style merged, so a row is a few `Text`s. */
export function merge(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = []

  for (const segment of segments) {
    if (segment.text === '') {
      continue
    }

    const last = out[out.length - 1]

    if (last && sameStyle(last, segment)) {
      last.text += segment.text
    } else {
      out.push({ ...segment })
    }
  }

  return out
}

function sameStyle(a: Segment, b: Segment): boolean {
  return a.color === b.color && a.bold === b.bold && a.italic === b.italic && a.dim === b.dim && a.inverse === b.inverse
}

/** The plain text of a row, for tests. */
export function lineText(segments: readonly Segment[]): string {
  return segments.map(segment => segment.text).join('')
}
