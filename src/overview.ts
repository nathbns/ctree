// The overview: the history with its linear runs folded into one row each,
// so what is left on screen is what shapes it (branch tips, tags, HEAD,
// merges, forks, roots, this session's commits) and the graph fits the pane.

import type { Commit } from './types'

/** A run of linear commits drawn as one row; `id` stands for it in the graph. */
export type Fold = {
  id: string
  /** Newest first, each the only parent of the one before. */
  commits: readonly Commit[]
}

export const FOLD_PREFIX = 'FOLD:'

/** Shorter runs stay as they are: folding one commit saves nothing. */
export const MIN_FOLD = 2

/**
 * `commits` (newest first, children before parents) with every run of at
 * least MIN_FOLD linear commits replaced by one pseudo-commit standing for
 * the run: it sits where the run's newest commit was, its parent is the
 * run's oldest commit's parent, and the child above points at it.
 *
 * A commit is linear when `isKept` lets it go, it has one parent and,
 * among the loaded commits, one child. Runs named in `opened` stay unfolded.
 */
export function collapse(
  commits: readonly Commit[],
  isKept: (commit: Commit) => boolean,
  opened: ReadonlySet<string>,
): { commits: Commit[]; folds: Map<string, Fold> } {
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const childCount = new Map<string, number>()

  for (const commit of commits) {
    for (const parent of commit.parents) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
    }
  }

  const isLinear = (commit: Commit) =>
    !isKept(commit) && commit.parents.length === 1 && childCount.get(commit.hash) === 1

  // A linear commit whose child is linear too sits inside a run: the run is
  // walked from its newest commit, which comes first in the list.
  const isInside = new Set<string>()

  for (const commit of commits) {
    const parent = byHash.get(commit.parents[0] ?? '')

    if (commit.parents.length === 1 && isLinear(commit) && parent && isLinear(parent)) {
      isInside.add(parent.hash)
    }
  }

  const folds = new Map<string, Fold>()
  const foldOf = new Map<string, Fold>()

  for (const commit of commits) {
    if (!isLinear(commit) || isInside.has(commit.hash)) {
      continue
    }

    const run: Commit[] = []
    let at: Commit | undefined = commit

    while (at && isLinear(at)) {
      run.push(at)
      at = byHash.get(at.parents[0] ?? '')
    }

    const id = FOLD_PREFIX + commit.hash

    if (run.length < MIN_FOLD || opened.has(id)) {
      continue
    }

    const fold: Fold = { id, commits: run }

    folds.set(id, fold)
    run.forEach(one => foldOf.set(one.hash, fold))
  }

  const out: Commit[] = []

  for (const commit of commits) {
    const fold = foldOf.get(commit.hash)

    if (fold) {
      // The run's newest commit is the first of it met: the fold goes there.
      if (fold.commits[0] === commit) {
        const oldest = fold.commits[fold.commits.length - 1] ?? commit

        out.push({ ...commit, hash: fold.id, parents: oldest.parents, subject: '' })
      }

      continue
    }

    out.push({
      ...commit,
      parents: commit.parents.map(parent => foldOf.get(parent)?.id ?? parent),
    })
  }

  return { commits: out, folds }
}

/** The fold holding `hash`, if the overview folded it. */
export function foldHolding(folds: ReadonlyMap<string, Fold>, hash: string): Fold | undefined {
  for (const fold of folds.values()) {
    if (fold.commits.some(commit => commit.hash === hash)) {
      return fold
    }
  }

  return undefined
}
