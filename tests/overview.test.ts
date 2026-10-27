import { describe, expect, test } from 'claude-code/testing'

import { computeGraph, DOWN, UP } from '../src/lanes'
import { collapse, FOLD_PREFIX, foldHolding } from '../src/overview'
import type { Commit } from '../src/types'

const c = (hash: string, ...parents: string[]): Commit => ({
  hash,
  parents,
  author: hash.startsWith('x') ? 'Léa Martin' : 'Nathan Test',
  email: '',
  time: 0,
  subject: hash,
})

const shape = (commits: readonly Commit[]) => commits.map(one => `${one.hash}<${one.parents.join(',')}`)

describe('the overview', () => {
  test('a linear run folds into one row where its newest commit was, the line kept whole', () => {
    const commits = [c('tip', 'a'), c('a', 'b'), c('b', 'c'), c('c', 'base'), c('base')]
    const { commits: shown, folds } = collapse(commits, one => one.hash === 'tip' || one.hash === 'base', new Set())

    expect(shape(shown)).toEqual(['tip<FOLD:a', 'FOLD:a<base', 'base<'])
    expect(folds.get(`${FOLD_PREFIX}a`)?.commits.map(one => one.hash)).toEqual(['a', 'b', 'c'])
  })

  test('a lone linear commit stays: folding one saves nothing', () => {
    const commits = [c('tip', 'a'), c('a', 'base'), c('base')]

    expect(shape(collapse(commits, one => one.hash !== 'a', new Set()).commits)).toEqual(['tip<a', 'a<base', 'base<'])
  })

  test('merges, forks, roots and kept commits are never folded, and they end runs', () => {
    // main: m3 (merge of f2) ← m2 ← m1 ← fork ← r1 ← root ; feature: f2 ← f1 ← fork
    const commits = [
      c('m3', 'm2', 'f2'),
      c('f2', 'f1'),
      c('m2', 'm1'),
      c('f1', 'fork'),
      c('m1', 'fork'),
      c('fork', 'r1'),
      c('r1', 'r0'),
      c('r0', 'root'),
      c('root'),
    ]
    const { commits: shown } = collapse(commits, one => one.hash === 'm3', new Set())

    // f2 ← f1 folds (reached as the merge's second parent), m2 ← m1 folds,
    // the fork point stays, r1 ← r0 folds, the root stays.
    expect(shape(shown)).toEqual([
      'm3<FOLD:m2,FOLD:f2',
      'FOLD:f2<fork',
      'FOLD:m2<fork',
      'fork<FOLD:r1',
      'FOLD:r1<root',
      'root<',
    ])
  })

  test('an opened run stays unfolded, the others fold', () => {
    const commits = [c('tip', 'a'), c('a', 'b'), c('b', 'base'), c('base')]
    const kept = (one: Commit) => one.hash === 'tip' || one.hash === 'base'

    expect(shape(collapse(commits, kept, new Set([`${FOLD_PREFIX}a`])).commits)).toEqual(['tip<a', 'a<b', 'b<base', 'base<'])
  })

  test('a run that goes on past the loaded commits points at what is not loaded yet', () => {
    const commits = [c('tip', 'a'), c('a', 'b'), c('b', 'unloaded')]

    expect(shape(collapse(commits, one => one.hash === 'tip', new Set()).commits)).toEqual(['tip<FOLD:a', 'FOLD:a<unloaded'])
  })

  test('the folded graph of a busy history is far shorter and still continuous', () => {
    const made: Commit[] = [c('root')]
    const heads = new Map([['main', 'root']])

    for (let i = 1; i <= 200; i += 1) {
      const branch = i % 10 < 7 ? 'main' : 'topic'
      const parent = heads.get(branch) ?? heads.get('main') ?? 'root'

      made.push(c(`${branch}${i}`, parent))
      heads.set(branch, `${branch}${i}`)

      if (i % 40 === 0) {
        made.push(c(`M${i}`, heads.get('main') ?? 'root', heads.get('topic') ?? 'root'))
        heads.set('main', `M${i}`)
        heads.delete('topic')
      }
    }

    const commits = [...made].reverse()
    const tips = new Set([...heads.values()])
    const { commits: shown } = collapse(commits, one => tips.has(one.hash), new Set())
    const { rows } = computeGraph(shown)

    expect(shown.length < commits.length / 3).toBe(true)

    rows.forEach((row, r) => {
      row.cells.forEach((cell, lane) => {
        const next = rows[r + 1]?.cells[lane]?.dirs ?? 0

        if (rows[r + 1]) expect(`${r}:${lane}:${(cell.dirs & DOWN) !== 0}`).toBe(`${r}:${lane}:${(next & UP) !== 0}`)
      })
    })
  })

  test('the fold holding a commit is found, to keep it selected', () => {
    const commits = [c('tip', 'a'), c('a', 'b'), c('b', 'base'), c('base')]
    const { folds } = collapse(commits, one => one.hash === 'tip' || one.hash === 'base', new Set())

    expect(foldHolding(folds, 'b')?.id).toBe(`${FOLD_PREFIX}a`)
    expect(foldHolding(folds, 'tip')).toBeUndefined()
  })
})
