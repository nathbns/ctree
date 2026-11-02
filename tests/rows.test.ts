import { describe, expect, test } from 'claude-code/testing'

import { HEAD_COLOR, STASH_COLOR } from '../src/colors'
import { columnsFor, graphLimit, textWidth } from '../src/layout'
import {
  buildView,
  commitLine,
  fileLine,
  foldLine,
  graphWidthOf,
  headerLine,
  lineText,
  type View,
  wipLine,
  withStashes,
} from '../src/rows'
import type { Commit, RepoSnapshot } from '../src/types'
import { COMMITS, h, inBoth, linearSnapshot, NOW, SNAPSHOT } from './fixtures'

function linesAt(snapshot: RepoSnapshot, width: number, selected?: string): string[] {
  const view = buildView(snapshot)
  const options = {
    width,
    graphWidth: graphWidthOf(view, [...view.rowOf.values()], graphLimit(width)),
    columns: columnsFor(width),
    now: NOW,
  }

  return [
    ...(snapshot.status.length ? [lineText(wipLine(view, snapshot.status.length, { ...options, isSelected: false }))] : []),
    ...snapshot.commits.map(commit => lineText(commitLine(view, commit, { ...options, isSelected: commit.hash === selected }))),
  ]
}

const at = (view: View, commit: Commit, width: number) =>
  commitLine(view, commit, {
    width,
    graphWidth: graphWidthOf(view, [...view.rowOf.values()], graphLimit(width)),
    columns: columnsFor(width),
    isSelected: false,
    now: NOW,
  })

describe('rows', () => {
  inBoth('the whole graph at 88 columns: lines, labels, author, date, hash', say => {
    // Each row's graph is as wide as its own lanes; the side columns stay aligned.
    expect(linesAt(SNAPSHOT, 88, h('3'))).toEqual(say([
      '  ◌ Uncommitted changes (2)',
      '  ┊ ● Panneau : colonnes adaptatives            feature/ui  Nathan           2h  1111111',
      '  ┊ ● Navigation j/k                                        Nathan           1d  2222222',
      // The current branch's chip is drawn inverse, padded by a space each side.
      "❯ ◉─┼─╮ Merge branch 'feature/la…  main ⇄ origin  ◇ v0.2.0  Nathan           5h  3333333",
      '  │ │ ● Calcul des lanes : octopus m… origin/feature/lanes  Léa              6h  4444444',
      '  │ │ ● Tests du calcul des lanes                           Léa              1d  5555555',
      '  ●─╯ │ Étiquettes de branches                              Nathan           2d  6666666',
      '  ●───╯ Parsing de git log                        ◇ v0.1.0  Nathan           3d  7777777',
      '  ● Commit initial                                          Nathan           2w  8888888',
    ], [
      '  ◌ Modifications non commitées (2)',
      '  ┊ ● Panneau : colonnes adaptatives            feature/ui  Nathan          2 h  1111111',
      '  ┊ ● Navigation j/k                                        Nathan          1 j  2222222',
      "❯ ◉─┼─╮ Merge branch 'feature/la…  main ⇄ origin  ◇ v0.2.0  Nathan          5 h  3333333",
      '  │ │ ● Calcul des lanes : octopus m… origin/feature/lanes  Léa             6 h  4444444',
      '  │ │ ● Tests du calcul des lanes                           Léa             1 j  5555555',
      '  ●─╯ │ Étiquettes de branches                              Nathan          2 j  6666666',
      '  ●───╯ Parsing de git log                        ◇ v0.1.0  Nathan          3 j  7777777',
      '  ● Commit initial                                          Nathan        2 sem  8888888',
    ]))
  })

  inBoth('secondary columns go as the pane narrows: author under 84, hash under 72, date under 60', say => {
    const view = buildView(SNAPSHOT)
    const commit = COMMITS[1] as Commit
    const day = say('1d', '1 j')

    expect(lineText(at(view, commit, 84))).toContain('Nathan')
    expect(lineText(at(view, commit, 83))).not.toContain('Nathan')
    expect(lineText(at(view, commit, 72))).toContain('2222222')
    expect(lineText(at(view, commit, 71))).not.toContain('2222222')
    expect(lineText(at(view, commit, 60))).toContain(day)
    expect(lineText(at(view, commit, 59))).not.toContain(day)
  })

  inBoth('at each threshold the side columns line up, the date right-aligned in its 7 columns', () => {
    const view = buildView(SNAPSHOT)

    for (const width of [84, 83, 72, 71, 60, 59]) {
      const lines = SNAPSHOT.commits.map(commit => lineText(at(view, commit, width)))

      // Every row ends at the same column: nothing a language's dates or words
      // add pushes a row past the pane or out of line.
      expect(`${width}: ${lines.every(line => textWidth(line) === width)}`).toBe(`${width}: true`)
    }
  })

  inBoth('no row is wider than the pane, whatever the width or the text', () => {
    const wide: RepoSnapshot = {
      ...SNAPSHOT,
      commits: COMMITS.map((commit, i) => (i === 3 ? { ...commit, subject: '中文提交信息很长很长很长很长很长很长很长很长 🎉 avec des accents éàü' } : commit)),
    }

    for (const width of [30, 44, 58, 70, 88, 120]) {
      for (const line of linesAt(wide, width)) {
        expect(`${width}: ${textWidth(line) <= width}`).toBe(`${width}: true`)
      }
    }
  })

  test('the current branch is a filled chip in its line’s colour, tags and remotes are not', () => {
    const view = buildView(SNAPSHOT)
    const merge = at(view, COMMITS[2] as Commit, 88)
    const chip = merge.find(segment => segment.text.includes('main ⇄ origin'))

    expect(chip).toMatchObject({ inverse: true, bold: true, color: HEAD_COLOR })
    expect(merge.find(segment => segment.text.includes('v0.2.0'))?.inverse).toBeUndefined()

    const remote = at(view, COMMITS[3] as Commit, 88).find(segment => segment.text.includes('origin/feature/lanes'))

    expect(remote?.italic).toBe(true)
  })

  test('HEAD’s node is ◉ and its line is blue down the first parents', () => {
    const view = buildView(SNAPSHOT)
    const merge = at(view, COMMITS[2] as Commit, 88)
    const node = merge.find(segment => segment.text.includes('◉'))
    const below = at(view, COMMITS[5] as Commit, 88).find(segment => segment.text.startsWith('●'))

    expect(node?.color).toBe(HEAD_COLOR)
    expect(below?.color).toBe(HEAD_COLOR)
  })

  test('a commit the session made is marked ✦', () => {
    const view = buildView({ ...SNAPSHOT, sessionCommits: [h('1')] })
    const line = lineText(at(view, COMMITS[0] as Commit, 88))

    expect(line).toContain('✦ Panneau')
  })

  test('labels that do not fit are counted', () => {
    const crowded: RepoSnapshot = {
      ...SNAPSHOT,
      refs: [
        ...SNAPSHOT.refs,
        { kind: 'tag', name: 'release-candidate-2026', target: h('3') },
        { kind: 'branch', name: 'hotfix/a-very-long-branch-name', target: h('3') },
      ],
    }
    const line = lineText(at(buildView(crowded), COMMITS[2] as Commit, 70))

    expect(line).toContain('main ⇄ origin')
    expect(/\+\d/.test(line)).toBe(true)
  })

  test('a file row continues the lanes and shows its status and counts', () => {
    const view = buildView(SNAPSHOT)
    const options = { width: 88, graphWidth: 6, columns: columnsFor(88), isSelected: false, now: NOW }
    const row = lineText(fileLine(view, h('3'), { status: 'R', path: 'src/render.ts', oldPath: 'src/graph.ts', added: 3, deleted: 1 }, options))

    // The three lanes run on; the status letter sits two columns past them.
    expect(row.startsWith('  │ │ │   R src/graph.ts → src/render.ts')).toBe(true)
    expect(row.endsWith('+3 −1')).toBe(true)
    expect(textWidth(row)).toBe(88)
  })

  test('a graph wider than four tenths of the row is cut, its node still shown', () => {
    const commits: Commit[] = [
      ...'abcdefghijklmn'.split('').map(tip => ({ hash: h('0').slice(0, 39) + tip, parents: [h('f')], author: 'x', email: '', time: 0, subject: tip })),
      { hash: h('f'), parents: [], author: 'x', email: '', time: 0, subject: 'root' },
    ]
    const snapshot: RepoSnapshot = { ...SNAPSHOT, commits, refs: [], status: [], head: { kind: 'detached', hash: h('f') } }
    const lines = linesAt(snapshot, 40)

    expect(lines.some(line => line.includes('…'))).toBe(true)
    expect(lines[13]?.includes('●')).toBe(true)
  })

  inBoth('the overview draws a folded run as one row: its count, its authors, its newest date', say => {
    const view = buildView(linearSnapshot(12), { opened: new Set() })
    const [fold] = [...view.folds.values()]

    expect(view.commits).toHaveLength(3)
    expect(fold?.commits).toHaveLength(10)

    const line = lineText(
      foldLine(view, fold!, { width: 88, graphWidth: 2, columns: columnsFor(88), isSelected: false, now: NOW }),
    )

    expect(line.startsWith('  ┆ ▸ 10 commits · Léa, Nathan')).toBe(true)
    expect(line.trimEnd().endsWith(say('1h', '1 h'))).toBe(true)
    expect(textWidth(line)).toBe(88)
  })

  inBoth('the header names the focus and the overview', say => {
    const focused: RepoSnapshot = {
      ...SNAPSHOT,
      scope: { kind: 'focus', ref: 'refs/heads/feature/ui', label: 'feature/ui', isFirstParent: true },
    }

    expect(lineText(headerLine(focused, 120, { isOverview: true }))).toBe(say(
      'demo · ⎇ main · ✓ origin/main · ◎ feature/ui · first parent · ▤ overview',
      'demo · ⎇ main · ✓ origin/main · ◎ feature/ui · 1er parent · ▤ vue d’ensemble',
    ))
  })

  test('a branch apart from its upstream says how far, in its label', () => {
    const drifted: RepoSnapshot = {
      ...SNAPSHOT,
      refs: SNAPSHOT.refs.map(ref =>
        ref.kind === 'branch' && ref.name === 'main' ? { ...ref, target: h('1'), track: [2, 1] as const } : ref,
      ),
      head: { kind: 'branch', branch: 'main', hash: h('1') },
    }
    const view = buildView(drifted)

    expect(lineText(at(view, COMMITS[0]!, 88))).toContain('main ↑2 ↓1')
    expect(lineText(at(view, COMMITS[2]!, 88))).toContain('origin/main')
  })

  inBoth('the header says where HEAD is and how it stands against its upstream', say => {
    const text = (snapshot: RepoSnapshot) => lineText(headerLine(snapshot, 120))
    const main = SNAPSHOT.refs[1]
    const ahead = { ...SNAPSHOT, refs: SNAPSHOT.refs.map(ref => (ref === main ? { ...ref, track: [2, 1] as const } : ref)) }
    const gone = { ...SNAPSHOT, refs: SNAPSHOT.refs.map(ref => (ref === main ? { ...ref, isUpstreamGone: true } : ref)) }

    expect(text(SNAPSHOT)).toBe('demo · ⎇ main · ✓ origin/main')
    expect(text(ahead)).toBe('demo · ⎇ main · ↑2 ↓1 origin/main')
    expect(text(gone)).toBe(say('demo · ⎇ main · origin/main gone', 'demo · ⎇ main · origin/main supprimée'))
    expect(text({ ...SNAPSHOT, head: { kind: 'detached', hash: h('4') } })).toBe(say('demo · detached HEAD @ 4444444', 'demo · HEAD détachée @ 4444444'))
    expect(text({ ...SNAPSHOT, head: { kind: 'branch', branch: 'main', hash: null } })).toBe(say('demo · ⎇ main · no commits yet', 'demo · ⎇ main · aucun commit'))
    expect(text({ ...SNAPSHOT, repo: { ...SNAPSHOT.repo, isLinkedWorktree: true }, sessionCommits: [h('1')] })).toBe(say(
      'demo · ⎇ main · ✓ origin/main · linked worktree · ✦ 1 this session',
      'demo · ⎇ main · ✓ origin/main · worktree secondaire · ✦ 1 cette session',
    ))
  })

  inBoth('a stash is drawn on the commit it was made on, where its date falls; one whose commit is not loaded waits', say => {
    const t = (n: number) => Math.floor(NOW / 1000) - n * 3600
    const stash = (digit: string, base: string, hours: number, selector: string, subject: string) =>
      ({ hash: h(digit), base, selector, author: 'Nathan Test', email: '', time: t(hours), subject })
    const snapshot: RepoSnapshot = {
      ...SNAPSHOT,
      stashes: [
        stash('a', h('3'), 1, 'stash@{0}', 'On main: essai'),
        stash('b', h('6'), 40, 'stash@{1}', 'WIP on main: 6666666 Étiquettes'),
        stash('c', h('e'), 1, 'stash@{2}', 'sur un commit pas encore chargé'),
      ],
    }
    const view = buildView(snapshot)
    const width = 88
    const options = { width, graphWidth: graphWidthOf(view, [...view.rowOf.values()], graphLimit(width)), columns: columnsFor(width), now: NOW, isSelected: false }

    expect([lineText(wipLine(view, 2, options)), ...view.commits.map(commit => lineText(commitLine(view, commit, options)))]).toEqual(say([
      '  ◌ Uncommitted changes (2)',
      '  ┊ ≡ On main: essai                           ≡ stash@{0}  Nathan           1h  aaaaaaa',
      '  ┊ │ ● Panneau : colonnes adaptatives          feature/ui  Nathan           2h  1111111',
      '  ┊ │ ● Navigation j/k                                      Nathan           1d  2222222',
      "  ◉─┴─┼─╮ Merge branch 'feature/…  main ⇄ origin  ◇ v0.2.0  Nathan           5h  3333333",
      '  │   │ ● Calcul des lanes : octopus… origin/feature/lanes  Léa              6h  4444444',
      '  │   │ ● Tests du calcul des lanes                         Léa              1d  5555555',
      '  │ ≡ │ │ WIP on main: 6666666 Étiquettes      ≡ stash@{1}  Nathan           1d  bbbbbbb',
      '  ●─┴─╯ │ Étiquettes de branches                            Nathan           2d  6666666',
      '  ●─────╯ Parsing de git log                      ◇ v0.1.0  Nathan           3d  7777777',
      '  ● Commit initial                                          Nathan           2w  8888888',
    ], [
      '  ◌ Modifications non commitées (2)',
      '  ┊ ≡ On main: essai                           ≡ stash@{0}  Nathan          1 h  aaaaaaa',
      '  ┊ │ ● Panneau : colonnes adaptatives          feature/ui  Nathan          2 h  1111111',
      '  ┊ │ ● Navigation j/k                                      Nathan          1 j  2222222',
      "  ◉─┴─┼─╮ Merge branch 'feature/…  main ⇄ origin  ◇ v0.2.0  Nathan          5 h  3333333",
      '  │   │ ● Calcul des lanes : octopus… origin/feature/lanes  Léa             6 h  4444444',
      '  │   │ ● Tests du calcul des lanes                         Léa             1 j  5555555',
      '  │ ≡ │ │ WIP on main: 6666666 Étiquettes      ≡ stash@{1}  Nathan          1 j  bbbbbbb',
      '  ●─┴─╯ │ Étiquettes de branches                            Nathan          2 j  6666666',
      '  ●─────╯ Parsing de git log                      ◇ v0.1.0  Nathan          3 j  7777777',
      '  ● Commit initial                                          Nathan        2 sem  8888888',
    ]))

    const node = commitLine(view, view.commits[0]!, options).find(segment => segment.text.includes('≡'))

    expect(node?.color).toBe(STASH_COLOR)
    // Above its commit even when its date is older than the commit's.
    expect(withStashes(COMMITS, [stash('d', h('8'), 9000, 'stash@{3}', 'vieux')]).map(commit => commit.hash.slice(0, 1))).toEqual(
      ['1', '2', '3', '4', '5', '6', '7', 'd', '8'],
    )
  })

  test('the overview keeps a stash and the commit it was made on', () => {
    const snapshot = linearSnapshot(12)
    const base = snapshot.commits[6]!
    const view = buildView(
      { ...snapshot, stashes: [{ hash: h('a'), base: base.hash, selector: 'stash@{0}', author: 'x', email: '', time: base.time, subject: 's' }] },
      { opened: new Set() },
    )

    expect(view.commits.some(commit => commit.hash === h('a'))).toBe(true)
    expect(view.commits.some(commit => commit.hash === base.hash)).toBe(true)
  })

  inBoth('a search result stands out, the marked commit is flagged, and the header says both', say => {
    const view = buildView(SNAPSHOT)
    const options = { width: 88, graphWidth: 8, columns: columnsFor(88), isSelected: false, now: NOW }
    const found = commitLine(view, COMMITS[3]!, { ...options, isMatch: true })
    const marked = lineText(commitLine(view, COMMITS[6]!, { ...options, isMarked: true }))

    expect(found.find(segment => segment.text.startsWith('Calcul'))?.color).toBe('warning')
    expect(marked).toContain('⚑ Parsing de git log')
    expect(textWidth(marked)).toBe(88)
    expect(lineText(headerLine(SNAPSHOT, 120, { mark: h('7'), search: { query: 'lanes', index: 1, count: 3 } }))).toBe(say(
      'demo · ⎇ main · ✓ origin/main · ⌕ "lanes" 2/3 · ⚑ 7777777',
      'demo · ⎇ main · ✓ origin/main · ⌕ « lanes » 2/3 · ⚑ 7777777',
    ))
    expect(lineText(headerLine(SNAPSHOT, 120, { search: { query: 'zzz', index: -1, count: 0 } }))).toContain(say('⌕ "zzz" none', '⌕ « zzz » aucun'))
  })
})
