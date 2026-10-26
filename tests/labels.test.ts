import { describe, expect, test } from 'claude-code/testing'

import { colorPaths, HEAD_COLOR, PALETTE } from '../src/colors'
import { computeGraph } from '../src/lanes'
import { labelsByCommit, labelText, refsByCommit } from '../src/labels'
import type { Ref } from '../src/types'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const texts = (refs: Ref[], head: Parameters<typeof labelsByCommit>[0]['head'], extra = {}) => {
  const labels = labelsByCommit({ refs, head, worktrees: [], toplevel: '/r', ...extra })

  return Object.fromEntries([...labels].map(([hash, list]) => [hash[0], list.map(labelText)]))
}

describe('labels', () => {
  test('a local branch and its upstream at the same commit are one label', () => {
    const refs: Ref[] = [
      { kind: 'branch', name: 'main', target: A, upstream: 'origin/main' },
      { kind: 'remote', name: 'origin/main', target: A },
    ]

    expect(texts(refs, { kind: 'branch', branch: 'main', hash: A })).toEqual({ a: ['main ⇄ origin'] })
  })

  test('apart, the branch and its remote are labelled on their own commits', () => {
    const refs: Ref[] = [
      { kind: 'branch', name: 'main', target: A, upstream: 'origin/main' },
      { kind: 'remote', name: 'origin/main', target: B },
    ]

    expect(texts(refs, { kind: 'branch', branch: 'main', hash: A })).toEqual({ a: ['main'], b: ['origin/main'] })
  })

  test('an upstream of another name keeps its full name; without upstream, the same name pairs', () => {
    const refs: Ref[] = [
      { kind: 'branch', name: 'feat', target: A, upstream: 'origin/feature-x' },
      { kind: 'remote', name: 'origin/feature-x', target: A },
      { kind: 'branch', name: 'docs', target: B },
      { kind: 'remote', name: 'upstream/docs', target: B },
    ]

    expect(texts(refs, { kind: 'branch', branch: 'docs', hash: B })).toEqual({
      a: ['feat ⇄ origin/feature-x'],
      b: ['docs ⇄ upstream'],
    })
  })

  test('HEAD’s branch comes first, then the other branches, remotes, tags', () => {
    const refs: Ref[] = [
      { kind: 'tag', name: 'v1', target: A },
      { kind: 'remote', name: 'origin/zeta', target: A },
      { kind: 'branch', name: 'alpha', target: A },
      { kind: 'branch', name: 'work', target: A },
    ]
    const labels = labelsByCommit({ refs, head: { kind: 'branch', branch: 'work', hash: A }, worktrees: [], toplevel: '/r' })

    expect(labels.get(A)?.map(labelText)).toEqual(['work', 'alpha', 'origin/zeta', '◇ v1'])
    expect(labels.get(A)?.[0]).toMatchObject({ kind: 'branch', isHead: true })
  })

  test('a detached HEAD has a label of its own, first', () => {
    const refs: Ref[] = [{ kind: 'tag', name: 'v2', target: C }]

    expect(texts(refs, { kind: 'detached', hash: C })).toEqual({ c: ['HEAD détachée', '◇ v2'] })
  })

  test('a branch checked out in another worktree says so', () => {
    const refs: Ref[] = [{ kind: 'branch', name: 'feature', target: B }]
    const worktrees = [
      { path: '/r', head: A, branch: 'main' },
      { path: '/r-feature', head: B, branch: 'feature' },
    ]

    expect(texts(refs, { kind: 'branch', branch: 'main', hash: A }, { worktrees })).toEqual({ b: ['feature (wt)'] })
  })
})

describe('colours', () => {
  const commits = [
    { hash: 'f2', parents: ['f1'] },
    { hash: 'm2', parents: ['m1'] },
    { hash: 'f1', parents: ['m1'] },
    { hash: 'm1', parents: [] },
  ]

  test('the current branch’s line is blue, a named branch takes its name’s colour', () => {
    const graph = computeGraph(commits)
    const refs = refsByCommit([
      { kind: 'branch', name: 'feature', target: 'f2' },
      { kind: 'branch', name: 'main', target: 'm2' },
    ])
    const colors = colorPaths(graph, refs, 'm2')
    const feature = colors[graph.rows[0]?.path ?? -1]

    expect(colors[graph.rows[1]?.path ?? -1]).toBe(HEAD_COLOR)
    expect(PALETTE).toContain(feature)

    // Same name, same colour, whatever else the history holds.
    const other = computeGraph([{ hash: 'x', parents: [] }, ...commits])
    const again = colorPaths(other, refs, 'm2')

    expect(again[other.rows[1]?.path ?? -1]).toBe(feature)
  })

  test('a local branch and its remote counterpart share a colour', () => {
    const graph = computeGraph(commits)
    const local = colorPaths(graph, refsByCommit([{ kind: 'branch', name: 'feature', target: 'f2' }]), 'm2')
    const remote = colorPaths(graph, refsByCommit([{ kind: 'remote', name: 'origin/feature', target: 'f2' }]), 'm2')

    expect(remote[graph.rows[0]?.path ?? -1]).toBe(local[graph.rows[0]?.path ?? -1])
  })

  test('side-by-side lines never start with the same colour', () => {
    const many = [
      { hash: 'm', parents: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(hash => ({ hash, parents: ['r'] })),
      { hash: 'r', parents: [] },
    ]
    const graph = computeGraph(many)
    const colors = colorPaths(graph, new Map(), null)
    const fan = graph.rows[0]?.below.map(path => (path === null ? '' : colors[path])) ?? []

    fan.forEach((color, i) => {
      expect(color === fan[i + 1]).toBe(false)
    })
  })
})
