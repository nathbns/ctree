// Searching the history: where the typed text is looked for (the message,
// the author, a hash, a changed file's path), the git reads that do it, and
// their answers merged into one list, newest first.

import * as Cmd from './git-commands'
import type { SearchBy } from './git-commands'
import { parseLog } from './git-parse'
import { stashCommit } from './rows'
import type { Commit, GitRunner, RepoSnapshot } from './types'

export type MatchKind = 'message' | 'author' | 'hash' | 'path'

export type SearchHit = { commit: Commit; by: readonly MatchKind[] }

export type SearchResult = {
  query: string
  hits: readonly SearchHit[]
  /** Kinds of match git could not finish in time: said under the results. */
  missed: readonly MatchKind[]
  /** One kind matched more than SEARCH_LIMIT commits: the oldest are left out. */
  isCut: boolean
}

/** How long one search read may take: a path search walks every commit's tree. */
export const SEARCH_TIMEOUT_MS = 15_000

/**
 * Where a typed text is looked for: always the message and the author; a
 * changed file's path when it looks like one (a `/` or a `.`, no space); a
 * hash when it could be one.
 */
export function searchPlan(text: string): { by: SearchBy[]; hash: string | null } {
  const query = text.trim()

  if (query === '') return { by: [], hash: null }

  const by: SearchBy[] = [
    { kind: 'message', text: query },
    { kind: 'author', text: query },
    ...(/[./]/.test(query) && !/\s/.test(query) ? [{ kind: 'path' as const, text: query }] : []),
  ]

  return { by, hash: /^[0-9a-f]{4,64}$/i.test(query) ? query.toLowerCase() : null }
}

/** The commits of the graph's history the text matches, newest first; the stashes too. */
export async function search(git: GitRunner, snapshot: RepoSnapshot, text: string): Promise<SearchResult> {
  const query = text.trim()
  const plan = searchPlan(query)
  const at = { cwd: snapshot.repo.toplevel, timeoutMs: SEARCH_TIMEOUT_MS }
  const withHead = snapshot.head.hash !== null
  const missed: MatchKind[] = []
  let isCut = false

  const found = await Promise.all([
    ...plan.by.map(async (by): Promise<[MatchKind, Commit[]]> => {
      const result = await git(Cmd.searchLog(by, snapshot.scope, withHead), at).catch(() => null)

      if (!result || result.code !== 0) {
        missed.push(by.kind)
        return [by.kind, []]
      }

      const commits = parseLog(result.stdout)

      isCut ||= commits.length >= Cmd.SEARCH_LIMIT

      return [by.kind, commits]
    }),
    (async (): Promise<[MatchKind, Commit[]]> => {
      if (!plan.hash) return ['hash', []]

      const resolved = await git(Cmd.resolveCommit(plan.hash), at).catch(() => null)
      const hash = resolved?.code === 0 ? resolved.stdout.trim() : ''

      if (!hash) return ['hash', []]

      const commit = await git(Cmd.commitsByHash([hash]), at).catch(() => null)

      return ['hash', commit?.code === 0 ? parseLog(commit.stdout) : []]
    })(),
  ])

  const needle = query.toLowerCase()
  const stashes = snapshot.stashes
    .filter(stash => stash.subject.toLowerCase().includes(needle) || stash.hash.startsWith(needle))
    .map(stash => ['message', [stashCommit(stash)]] as [MatchKind, Commit[]])
  const hits = new Map<string, { commit: Commit; by: MatchKind[] }>()

  for (const [kind, commits] of [...found, ...stashes]) {
    for (const commit of commits) {
      const hit = hits.get(commit.hash)

      if (!hit) hits.set(commit.hash, { commit, by: [kind] })
      else if (!hit.by.includes(kind)) hit.by.push(kind)
    }
  }

  return {
    query,
    hits: [...hits.values()].sort((a, b) => b.commit.time - a.commit.time),
    missed,
    isCut,
  }
}

/** How a hit matched, in a word each: `message · fichier`. */
export function matchWords(by: readonly MatchKind[]): string {
  const words: Record<MatchKind, string> = { message: 'message', author: 'auteur', hash: 'hash', path: 'fichier' }

  return by.map(kind => words[kind]).join(' · ')
}
