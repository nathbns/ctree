import { describe, expect, test } from 'claude-code/testing'

import { search, searchPlan } from '../src/search'
import type { GitRunner } from '../src/types'
import { COMMITS, h, logOf, SNAPSHOT } from './fixtures'

describe('where a search looks', () => {
  test('the message and the author always; a path when it looks like one; a hash when it could be one', () => {
    expect(searchPlan('  lanes ').by.map(by => by.kind)).toEqual(['message', 'author'])
    expect(searchPlan('src/lanes.ts').by.map(by => by.kind)).toEqual(['message', 'author', 'path'])
    expect(searchPlan('fix the lanes.').by.map(by => by.kind)).toEqual(['message', 'author'])
    expect(searchPlan('3A3b').hash).toBe('3a3b')
    expect(searchPlan('abc').hash).toBeNull()
    expect(searchPlan('   ').by).toEqual([])
  })
})

describe('searching', () => {
  /** git answering each kind of search from a few commits; a path search takes too long. */
  const git: GitRunner = async args => {
    const line = args.join(' ')

    if (args[0] === 'rev-parse') return { code: 0, stdout: `${h('4')}\n`, stderr: '' }
    if (line.includes('--no-walk')) return { code: 0, stdout: logOf([COMMITS[3]!]), stderr: '' }
    if (line.includes('--grep=')) return { code: 0, stdout: logOf([COMMITS[3]!, COMMITS[4]!]), stderr: '' }
    if (line.includes('--author=')) return { code: 0, stdout: logOf([COMMITS[4]!]), stderr: '' }
    if (line.includes(':(literal)src/lanes.ts')) return { code: 0, stdout: logOf([COMMITS[4]!]), stderr: '' }
    if (line.includes(':(literal)')) return { code: 0, stdout: '', stderr: '' }
    if (line.includes(':(glob,icase)')) return { code: 124, stdout: '', stderr: 'timed out' }

    return { code: 1, stdout: '', stderr: `unexpected ${line}` }
  }

  test('every kind of match merged, newest first, each saying how it matched; what timed out is said', async () => {
    const snapshot = {
      ...SNAPSHOT,
      stashes: [{ hash: h('a'), base: h('3'), selector: 'stash@{0}', author: 'Nathan', email: '', time: COMMITS[0]!.time + 60, subject: 'On main: lanes en cours' }],
    }
    const result = await search(git, snapshot, 'lanes')

    expect(result.hits.map(hit => [hit.commit.hash.slice(0, 1), hit.by])).toEqual([
      ['a', ['message']],
      ['4', ['message']],
      ['5', ['message', 'author']],
    ])
    expect(result.hits[0]?.commit.stash).toBe('stash@{0}')
    expect(result.missed).toEqual([])

    const exact = await search(git, SNAPSHOT, 'src/lanes.ts')

    expect(exact.hits.find(hit => hit.by.includes('path'))?.commit.hash).toBe(h('5'))
    expect(exact.missed).toEqual([])

    // Not a path from the top: anywhere in a path, which here runs out of time.
    const anywhere = await search(git, SNAPSHOT, 'lanes.ts')

    expect(anywhere.missed).toEqual(['path'])
  })

  test('a hash finds its commit', async () => {
    const result = await search(git, SNAPSHOT, '4444')

    expect(result.hits.find(hit => hit.by.includes('hash'))?.commit.hash).toBe(h('4'))
  })
})
