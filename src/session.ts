// The session view: what this conversation changed in the repository, from
// where every ref stood when it started to where they stand now.

import * as Cmd from './git-commands'
import { joinChanges, parseLog, parseNameStatus, parseNumstat } from './git-parse'
import { diffRefs, type RefState, shortRef } from './journal'
import type { Commit, FileChange, GitRunner } from './types'

export type RefChange = {
  /** `main`, `◇ v1.0`, `origin/main`. */
  name: string
  kind: 'branch' | 'tag' | 'remote'
  change: 'new' | 'deleted' | 'moved'
  before: string | null
  after: string | null
  /** For a moved branch: commits gained and lost. */
  gained?: number
  lost?: number
}

export type SessionData = {
  since: number
  refs: RefChange[]
  /** This session's commits (✦), newest first, 50 at most. */
  commits: Commit[]
  /** HEAD's changes since the session started, when HEAD moved. */
  files: FileChange[]
  headBefore: string | null
  headAfter: string | null
}

const kindOf = (ref: string): RefChange['kind'] =>
  ref.startsWith('refs/tags/') ? 'tag' : ref.startsWith('refs/remotes/') ? 'remote' : 'branch'

/** Counted ranges per view: past this many moved refs, they are listed without counts. */
const COUNTED = 10

export async function loadSessionData(
  git: GitRunner,
  toplevel: string,
  start: RefState & { at: number },
  now: RefState,
  sessionCommits: readonly string[],
): Promise<SessionData> {
  const at = { cwd: toplevel }
  const moves = diffRefs(start, now)
  const refs: RefChange[] = await Promise.all(
    moves.map(async (move, i): Promise<RefChange> => {
      const kind = kindOf(move.ref)
      const name = `${kind === 'tag' ? '◇ ' : ''}${shortRef(move.ref)}`
      const change = move.before === null ? 'new' : move.after === null ? 'deleted' : 'moved'
      const base: RefChange = { name, kind, change, before: move.before, after: move.after }

      if (change !== 'moved' || kind === 'tag' || i >= COUNTED || !move.before || !move.after) {
        return base
      }

      const [gained, lost] = await Promise.all([
        git(Cmd.countRange(move.before, move.after), at),
        git(Cmd.countRange(move.after, move.before), at),
      ])

      return { ...base, gained: Number(gained.stdout.trim()) || 0, lost: Number(lost.stdout.trim()) || 0 }
    }),
  )

  const hashes = sessionCommits.slice(0, 50)
  const [logged, files] = await Promise.all([
    hashes.length ? git(Cmd.commitsByHash(hashes), at) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    loadHeadChanges(git, toplevel, start.head.hash, now.head.hash),
  ])

  return {
    since: start.at,
    refs,
    commits: logged.code === 0 ? parseLog(logged.stdout) : [],
    files,
    headBefore: start.head.hash,
    headAfter: now.head.hash,
  }
}

async function loadHeadChanges(git: GitRunner, toplevel: string, before: string | null, after: string | null): Promise<FileChange[]> {
  if (!before || !after || before === after) {
    return []
  }

  const [statuses, counts] = await Promise.all([
    git(Cmd.commitNameStatus(after, before), { cwd: toplevel }),
    git(Cmd.commitNumstat(after, before), { cwd: toplevel }),
  ])

  return statuses.code === 0 ? joinChanges(parseNameStatus(statuses.stdout), counts.code === 0 ? parseNumstat(counts.stdout) : []) : []
}

/** The question `e` asks in the session view: a pull request description of it all. */
export function prDescriptionPrompt(data: SessionData): string {
  const refs = data.refs.filter(ref => ref.kind === 'branch').map(ref => ref.name)
  const added = data.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const deleted = data.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)

  return (
    `Rédige la description de pull request de ce que cette session a changé` +
    (refs.length ? ` (branches ${refs.join(', ')})` : '') +
    ` : ${data.commits.length} commits, ${data.files.length} fichiers (+${added} −${deleted}). ` +
    `Lis-les avec git log et git diff ${data.headBefore?.slice(0, 7) ?? ''}..HEAD. ` +
    'Donne un titre, un résumé, la liste des changements et ce qu’il faut vérifier.'
  )
}
