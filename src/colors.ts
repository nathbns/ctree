// One colour per line of history, stable across refreshes: a line takes the
// colour its branch's name hashes to, the current branch's line is always the
// blue VS Code draws it in, and a line never shares the colour of the lines
// beside it where it starts.

import type { Graph } from './lanes'
import type { Ref } from './types'

/** VS Code's `scmGraph.historyItemRefColor`: the current branch. */
export const HEAD_COLOR = '#59A4F9'

/** VS Code's `scmGraph.foreground1..5`, then two more of the same weight. */
export const PALETTE: readonly string[] = [
  '#FFB000',
  '#DC267F',
  '#40B0A6',
  '#B66DFF',
  '#994F00',
  '#6CC644',
  '#F97583',
]

/** The dashed line from the uncommitted changes to HEAD. */
export const DASHED_COLOR = 'inactive'

export const TAG_COLOR = '#D7BA7D'

/**
 * The colour of every path of `graph`, by path id.
 *
 * @param refsAt the refs pointing at each commit
 * @param head the commit HEAD points at, if any
 */
export function colorPaths(
  graph: Graph,
  refsAt: ReadonlyMap<string, readonly Ref[]>,
  head: string | null,
): string[] {
  const colors: string[] = []
  let unnamed = 0

  for (const path of graph.paths) {
    if (path.isDashed) {
      colors.push(DASHED_COLOR)
      continue
    }

    if (head !== null && path.commits.includes(head)) {
      colors.push(HEAD_COLOR)
      continue
    }

    const name = branchNameOf(path.commits, refsAt)
    let pick = name === null ? unnamed++ % PALETTE.length : hash(name) % PALETTE.length
    const avoid = neighbourColors(graph, path.id, colors)

    for (let tries = 0; tries < PALETTE.length && avoid.has(PALETTE[pick] ?? ''); tries += 1) {
      pick = (pick + 1) % PALETTE.length
    }

    colors.push(PALETTE[pick] ?? PALETTE[0] ?? HEAD_COLOR)
  }

  return colors
}

/**
 * The branch a line belongs to: the first local branch on it, else the first
 * remote one with its remote dropped, so `feature` and `origin/feature` match.
 */
function branchNameOf(
  commits: readonly string[],
  refsAt: ReadonlyMap<string, readonly Ref[]>,
): string | null {
  let remote: string | null = null

  for (const commit of commits) {
    for (const ref of refsAt.get(commit) ?? []) {
      if (ref.kind === 'branch') {
        return ref.name
      }

      if (ref.kind === 'remote' && remote === null) {
        remote = ref.name.slice(ref.name.indexOf('/') + 1)
      }
    }
  }

  return remote
}

/** Colours already given to the lines next to where this one starts. */
function neighbourColors(graph: Graph, pathId: number, colors: readonly string[]): Set<string> {
  const path = graph.paths[pathId]
  const row = path ? graph.rows[path.startRow] : undefined
  const near = new Set<string>()

  if (!path || !row) {
    return near
  }

  const ids = [
    row.path,
    row.cells[path.startLane - 1]?.vPath,
    row.cells[path.startLane + 1]?.vPath,
    row.below[path.startLane - 1],
    row.below[path.startLane + 1],
  ]

  for (const id of ids) {
    const color = id === undefined || id === null || id === pathId ? undefined : colors[id]

    if (color) {
      near.add(color)
    }
  }

  return near
}

/** FNV-1a, 32 bits: the same name always lands on the same colour. */
function hash(text: string): number {
  let h = 0x811c9dc5

  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return h >>> 0
}
