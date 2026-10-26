import { describe, expect, test } from 'claude-code/testing'

import { computeGraph, DOWN, type GraphCommit, LEFT, RIGHT, rowText, UP } from '../src/lanes'

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents })

/** The graph drawn as text, one row per commit, `○` for merges. */
function draw(commits: readonly GraphCommit[], dashed?: string): string[] {
  const graph = computeGraph(commits, dashed ? { dashed } : {})

  return graph.rows.map((row, i) => {
    const commit = commits[i]
    const node = commit?.hash === dashed ? '◌' : (commit?.parents.length ?? 0) > 1 ? '○' : '●'

    return rowText(row, graph.paths, node)
  })
}

/**
 * Every line that leaves a row downward arrives in the next row from above,
 * in the same lane, and nothing arrives from nowhere: the graph never breaks.
 */
function expectContinuous(commits: readonly GraphCommit[]): void {
  const { rows } = computeGraph(commits)

  rows.forEach((row, r) => {
    const next = rows[r + 1]

    row.cells.forEach((cell, lane) => {
      const goesDown = (cell.dirs & DOWN) !== 0
      const comesUp = ((next?.cells[lane]?.dirs ?? 0) & UP) !== 0

      if (next) {
        expect(`${r}:${lane}:${goesDown}`).toBe(`${r}:${lane}:${comesUp}`)
      }

      if (cell.dirs & LEFT) expect(((row.cells[lane - 1]?.dirs ?? 0) & RIGHT) !== 0).toBe(true)
      if (cell.dirs & RIGHT) expect(((row.cells[lane + 1]?.dirs ?? 0) & LEFT) !== 0).toBe(true)
    })
  })
}

describe('lanes', () => {
  test('a straight history is one lane', () => {
    expect(draw([c('c', 'b'), c('b', 'a'), c('a')])).toEqual(['●', '●', '●'])
  })

  test('two parallel branches fork from one commit and keep their own lanes', () => {
    const commits = [c('m2', 'm1'), c('f2', 'f1'), c('m1', 'base'), c('f1', 'base'), c('base')]

    expect(draw(commits)).toEqual(['●', '│ ●', '● │', '│ ●', '●─╯'])
    expectContinuous(commits)
  })

  test('a merge opens a lane to the right and the branch joins back at its fork', () => {
    const commits = [c('m', 'a', 'f2'), c('f2', 'f1'), c('a', 'base'), c('f1', 'base'), c('base')]

    expect(draw(commits)).toEqual(['○─╮', '│ ●', '● │', '│ ●', '●─╯'])
    expectContinuous(commits)
  })

  test('several merges in a row, each branch on its own lane, the merge line crossing', () => {
    const commits = [
      c('m3', 'm2', 'f2'),
      c('f2', 'f1'),
      c('m2', 'm1', 'g1'),
      c('g1', 'm1'),
      c('f1', 'm1'),
      c('m1'),
    ]

    expect(draw(commits)).toEqual(['○─╮', '│ ●', '○─┼─╮', '│ │ ●', '│ ● │', '●─┴─╯'])
    expectContinuous(commits)
  })

  test('an octopus merge fans out to every parent and they meet again', () => {
    const commits = [c('M', 'A', 'B', 'C', 'D'), c('A', 'R'), c('B', 'R'), c('C', 'R'), c('D', 'R'), c('R')]

    expect(draw(commits)).toEqual(['○─┬─┬─╮', '● │ │ │', '│ ● │ │', '│ │ ● │', '│ │ │ ●', '●─┴─┴─╯'])
    expectContinuous(commits)
  })

  test('a merge whose parent another lane already waits for joins that lane', () => {
    // When the merge comes, lane 0 already carries the line down to `x`.
    const commits = [c('f', 'x'), c('m', 'a', 'x'), c('a', 'x'), c('x')]

    expect(draw(commits)).toEqual(['●', '├─○', '│ ●', '●─╯'])
    expect(computeGraph(commits).rows[1]?.cells).toHaveLength(2)
    expectContinuous(commits)
  })

  test('unrelated histories (two roots) sit side by side', () => {
    const commits = [c('a2', 'a1'), c('b2', 'b1'), c('a1'), c('b1')]

    expect(draw(commits)).toEqual(['●', '│ ●', '● │', '  ●'])
    expectContinuous(commits)
  })

  test('a lane freed by a join is reused by the next branch tip', () => {
    const commits = [c('t1', 'base'), c('t2', 'base'), c('base', 'root'), c('t3', 'root'), c('root')]
    const rows = draw(commits)

    expect(rows).toEqual(['●', '│ ●', '●─╯', '│ ●', '●─╯'])
  })

  test('the uncommitted changes hang off HEAD on a dashed line', () => {
    const commits = [c('WIP', 'h'), c('t', 'h'), c('h', 'a'), c('a')]

    expect(draw(commits, 'WIP')).toEqual(['◌', '┊ ●', '●─╯', '●'])

    const graph = computeGraph(commits, { dashed: 'WIP' })

    // HEAD starts a line of its own: the dashed one ends there.
    expect(graph.paths[graph.rows[2]?.path ?? 0]?.isDashed).toBe(false)
    expect(graph.paths[graph.rows[0]?.path ?? 0]?.isDashed).toBe(true)
  })

  test('loading more commits never changes the rows already drawn', () => {
    const commits = [
      c('m3', 'm2', 'f2'),
      c('f2', 'f1'),
      c('m2', 'm1', 'g1'),
      c('g1', 'm1'),
      c('f1', 'm1'),
      c('m1', 'm0'),
      c('m0'),
    ]
    const whole = draw(commits)

    for (let n = 1; n < commits.length; n += 1) {
      expect(draw(commits.slice(0, n))).toEqual(whole.slice(0, n))
    }
  })

  test('a busy history stays continuous and draws box-drawing glyphs only', () => {
    // 120 commits made in time order over four branches, two of them merged
    // into main every few commits; newest first is then a valid topo order.
    const made: GraphCommit[] = [c('root')]
    const heads = new Map([['main', 'root']])

    for (let i = 1; i <= 120; i += 1) {
      const branch = ['main', 'a', 'b', 'c'][i % 4] ?? 'main'
      const parent = heads.get(branch) ?? heads.get('main') ?? 'root'
      const hash = `${branch}${i}`

      made.push(c(hash, parent))
      heads.set(branch, hash)

      if (i % 7 === 0 || i % 11 === 0) {
        const merged = i % 7 === 0 ? 'a' : 'b'
        const merge = `M${i}`

        made.push(c(merge, heads.get('main') ?? 'root', heads.get(merged) ?? 'root'))
        heads.set('main', merge)
        heads.delete(merged)
      }
    }

    const commits = [...made].reverse()

    expectContinuous(commits)

    for (const row of draw(commits)) {
      expect(/^[●○◌│┊─╮╭╯╰┤├┬┴┼ ]*$/.test(row)).toBe(true)
    }
  })
})
