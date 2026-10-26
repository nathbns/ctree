// The commit graph laid out one row per commit, the way VS Code's Source
// Control graph and Git Graph draw it: each commit sits on a lane, a lane
// carries the line down to the commit it expects next, and a merge or a fork
// is drawn on the commit's own row as a horizontal run to the other lane.
//
// Every cell records the directions it connects to (up, down, left, right)
// and the path each part belongs to; glyphs and colours are chosen later.

export const UP = 1
export const DOWN = 2
export const LEFT = 4
export const RIGHT = 8

export type GraphCommit = { hash: string; parents: readonly string[] }

/** One lane's cell on one row. */
export type LaneCell = {
  /** UP | DOWN | LEFT | RIGHT bits. */
  dirs: number
  /** Path of the vertical part. */
  vPath?: number
  /** Path of the horizontal part. */
  hPath?: number
  /** The row's commit sits here. */
  isNode?: true
}

export type GraphRow = {
  /** Lane of the row's commit. */
  lane: number
  /** Path the commit sits on. */
  path: number
  /** One cell per lane, as wide as the row's widest lane. */
  cells: LaneCell[]
  /** Path of the horizontal run through the gap right of each lane. */
  gaps: (number | undefined)[]
  /** Path of each lane running on below the row, null where none does. */
  below: (number | null)[]
}

/** A line of history: a commit and its first-parent chain, until it ends or joins another. */
export type Path = {
  id: number
  /** Drawn dashed: the line from the uncommitted changes down to HEAD. */
  isDashed: boolean
  startRow: number
  startLane: number
  /** Hashes of the commits drawn on it, top down. */
  commits: string[]
}

export type Graph = {
  rows: GraphRow[]
  paths: Path[]
}

type Slot = { hash: string; path: number } | null

/**
 * Lays out `commits`, given newest first with every child before its
 * parents (`git log --topo-order`). `dashed` names a commit whose line down
 * to its parent is drawn dashed (the uncommitted changes' pseudo-commit).
 */
export function computeGraph(
  commits: readonly GraphCommit[],
  options: { dashed?: string } = {},
): Graph {
  const rows: GraphRow[] = []
  const paths: Path[] = []
  const lanes: Slot[] = []

  const newPath = (row: number, lane: number, isDashed = false): number => {
    const id = paths.length

    paths.push({ id, isDashed, startRow: row, startLane: lane, commits: [] })

    return id
  }

  commits.forEach((commit, row) => {
    const cells: LaneCell[] = []
    const gaps: (number | undefined)[] = []
    const cell = (lane: number): LaneCell => (cells[lane] ??= { dirs: 0 })
    const matches = lanes.flatMap((slot, i) => (slot?.hash === commit.hash ? [i] : []))
    const isDashed = commit.hash === options.dashed
    const freed = new Set<number>()
    const links: { lane: number; path: number }[] = []

    let lane: number
    let path: number

    if (matches.length === 0) {
      lane = firstFree(lanes, 0, freed)
      path = newPath(row, lane, isDashed)
    } else {
      lane = matches[0] ?? 0
      const above = lanes[lane]?.path ?? 0

      cell(lane).dirs |= UP
      cell(lane).vPath = above
      path = paths[above]?.isDashed || isDashed ? newPath(row, lane, isDashed) : above
    }

    lanes.forEach((slot, i) => {
      if (slot && !matches.includes(i)) {
        const through = cell(i)

        through.dirs |= UP | DOWN
        through.vPath = slot.path
      }
    })

    for (const other of matches.slice(1)) {
      const joining = lanes[other]?.path ?? 0

      cell(other).dirs |= UP
      cell(other).vPath = joining
      links.push({ lane: other, path: joining })
      lanes[other] = null
      freed.add(other)
    }

    cell(lane).isNode = true
    paths[path]?.commits.push(commit.hash)

    const [first, ...others] = commit.parents

    if (first === undefined) {
      lanes[lane] = null
    } else {
      lanes[lane] = { hash: first, path }
      cell(lane).dirs |= DOWN
    }

    for (const parent of others) {
      const existing = lanes.findIndex((slot, i) => i !== lane && slot?.hash === parent)

      if (existing !== -1) {
        links.push({ lane: existing, path: lanes[existing]?.path ?? 0 })
        continue
      }

      const target = firstFree(lanes, lane + 1, freed)
      const branch = newPath(row, target)

      lanes[target] = { hash: parent, path: branch }
      cell(target).dirs |= DOWN
      cell(target).vPath = branch
      links.push({ lane: target, path: branch })
    }

    // The nearest link colours the run they share.
    links.sort((a, b) => Math.abs(a.lane - lane) - Math.abs(b.lane - lane))

    for (const link of links) {
      connect(cell, gaps, lane, link.lane, link.path)
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
    }

    const width = Math.max(cells.length, lane + 1)

    for (let i = 0; i < width; i += 1) {
      cell(i)
    }

    rows.push({
      lane,
      path,
      cells,
      gaps,
      below: lanes.map(slot => slot?.path ?? null),
    })
  })

  return { rows, paths }
}

/** The first free lane at or right of `from`, else a new one at the end. */
function firstFree(lanes: readonly Slot[], from: number, taken: ReadonlySet<number>): number {
  for (let i = from; i < lanes.length; i += 1) {
    if (lanes[i] === null && !taken.has(i)) {
      return i
    }
  }

  return lanes.length
}

/** Draws a horizontal run from the node's lane to `to`, owned by `path`. */
function connect(
  cell: (lane: number) => LaneCell,
  gaps: (number | undefined)[],
  from: number,
  to: number,
  path: number,
): void {
  if (to === from) {
    return
  }

  const right = to > from
  const low = Math.min(from, to)
  const high = Math.max(from, to)

  cell(from).dirs |= right ? RIGHT : LEFT

  for (let i = low + 1; i < high; i += 1) {
    const between = cell(i)

    between.dirs |= LEFT | RIGHT
    between.hPath ??= path
  }

  const end = cell(to)

  end.dirs |= right ? LEFT : RIGHT
  end.hPath ??= path

  for (let gap = low; gap < high; gap += 1) {
    gaps[gap] ??= path
  }
}

/** The box-drawing glyph for a cell's directions (nodes are drawn apart). */
export function glyphOf(dirs: number, isDashed = false): string {
  const vertical = isDashed ? '┊' : '│'

  switch (dirs) {
    case 0: return ' '
    case UP:
    case DOWN:
    case UP | DOWN: return vertical
    case LEFT:
    case RIGHT:
    case LEFT | RIGHT: return '─'
    case DOWN | LEFT: return '╮'
    case DOWN | RIGHT: return '╭'
    case UP | LEFT: return '╯'
    case UP | RIGHT: return '╰'
    case UP | DOWN | LEFT: return '┤'
    case UP | DOWN | RIGHT: return '├'
    case LEFT | RIGHT | DOWN: return '┬'
    case LEFT | RIGHT | UP: return '┴'
    default: return '┼'
  }
}

/**
 * A row as plain text, two characters per lane (`●─╮`), for tests and
 * debugging. `node` draws the commit.
 */
export function rowText(row: GraphRow, paths: readonly Path[], node = '●'): string {
  let out = ''

  row.cells.forEach((cell, i) => {
    const vPath = cell.vPath === undefined ? undefined : paths[cell.vPath]

    out += cell.isNode ? node : glyphOf(cell.dirs, vPath?.isDashed === true && cell.hPath === undefined)
    out += row.gaps[i] === undefined ? ' ' : '─'
  })

  return out.replace(/\s+$/, '')
}
