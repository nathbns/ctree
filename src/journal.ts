// The journal of Claude's git commands: where the refs stood before and after
// each, and how to put them back. Undoing moves local branches and tags back
// (only those still where the command left them), switches HEAD back, and can
// restore the tracked changes a command threw away; a push is never undone.

import type { CtreeHead, CtreeJournalEntry, CtreeRefMove, CtreeRefState } from '../types'
import * as Cmd from './git-commands'
import { FIELD } from './git-commands'
import { keepsFiles } from './guard'
import type { GitRunner } from './types'

export type RefState = CtreeRefState
export type JournalEntry = CtreeJournalEntry
export type RefMove = CtreeRefMove

/** The value `update-ref` reads as "this ref must not exist". */
export const ZERO = '0'.repeat(40)

/** Journal entries kept, newest first. */
export const JOURNAL_SIZE = 50

/** The refs and HEAD now; null outside a repository. */
export async function readRefState(git: GitRunner, cwd: string): Promise<RefState | null> {
  const [refs, symbolic, head] = await Promise.all([
    git(Cmd.refState(), { cwd }),
    git(Cmd.headRef(), { cwd }),
    git(Cmd.headCommit(), { cwd }),
  ])

  if (refs.code !== 0) {
    return null
  }

  const map: Record<string, string> = {}

  for (const line of refs.stdout.split('\n')) {
    const [ref, hash] = line.split(FIELD)

    if (ref && hash && !ref.endsWith('/HEAD')) {
      map[ref] = hash
    }
  }

  const branchRef = symbolic.code === 0 ? symbolic.stdout.trim() : ''

  return {
    refs: map,
    head: {
      branch: branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : null,
      hash: head.code === 0 ? head.stdout.trim() || null : null,
    },
  }
}

/** Every ref that differs between two states. */
export function diffRefs(before: RefState, after: RefState): RefMove[] {
  const names = [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].sort()

  return names
    .map(ref => ({ ref, before: before.refs[ref] ?? null, after: after.refs[ref] ?? null }))
    .filter(move => move.before !== move.after)
}

const sameHead = (a: CtreeHead, b: CtreeHead) => a.branch === b.branch && a.hash === b.hash

/** An entry for a command, or null when it changed nothing worth undoing. */
export function journalEntry(input: {
  at: number
  turn: number
  command: string
  isSubagent: boolean
  before: RefState
  after: RefState
  saved?: { hash: string; files: number }
}): JournalEntry | null {
  const moves = diffRefs(input.before, input.after)

  if (moves.length === 0 && sameHead(input.before.head, input.after.head) && !input.saved) {
    return null
  }

  return {
    id: String(input.at),
    at: input.at,
    turn: input.turn,
    command: input.command.length > 200 ? `${input.command.slice(0, 199)}…` : input.command,
    isSubagent: input.isSubagent,
    moves,
    head: { before: input.before.head, after: input.after.head },
    ...(input.saved ? { saved: input.saved.hash, savedFiles: input.saved.files } : {}),
  }
}

/** The journal with one more entry, newest first, kept to JOURNAL_SIZE. */
export function appended(journal: readonly JournalEntry[], entry: JournalEntry): JournalEntry[] {
  return [entry, ...journal].slice(0, JOURNAL_SIZE)
}

const isLocal = (ref: string) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')

/** `refs/heads/main` → `main`, `refs/remotes/origin/x` → `origin/x`. */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags|remotes)\//, '')
}

const short = (hash: string | null) => (hash ? hash.slice(0, 7) : '∅')

/** What an entry did, one phrase per ref, for the journal's second line. */
export function describeMoves(entry: JournalEntry): string[] {
  const out: string[] = []
  const { before, after } = entry.head

  if (before.branch !== after.branch) {
    out.push(`HEAD : ${before.branch ?? short(before.hash)} → ${after.branch ?? `détachée ${short(after.hash)}`}`)
  }

  for (const move of entry.moves) {
    const name = `${move.ref.startsWith('refs/tags/') ? '◇ ' : ''}${shortRef(move.ref)}`

    if (move.before === null) out.push(`${name} créée`)
    else if (move.after === null) out.push(`${name} supprimée (était ${short(move.before)})`)
    else out.push(`${name} ${short(move.before)} → ${short(move.after)}`)
  }

  if (entry.saved) {
    out.push(`${entry.savedFiles ?? 0} fichier${(entry.savedFiles ?? 0) > 1 ? 's' : ''} modifié${(entry.savedFiles ?? 0) > 1 ? 's' : ''} sauvé${(entry.savedFiles ?? 0) > 1 ? 's' : ''} avant`)
  }

  return out
}

export type UndoPlan = {
  /** Commands that put the refs and HEAD back, in order. */
  steps: string[][]
  /** What is left as it is, and why. */
  notes: string[]
  /** `stash apply` of the saved changes, offered on top. */
  restore: string[] | null
}

/**
 * How to undo `entry` from the state `now`: deleted refs made again, HEAD
 * switched back, moved refs moved back, made refs deleted, HEAD's branch
 * reset. After a command that left the files alone (a commit, an amend) the
 * reset is --soft, so its changes come back uncommitted, as they were; after
 * one that changed them (reset --hard, merge, rebase) it is --keep, which
 * puts the files back and refuses to overwrite local changes. A ref that
 * moved again since is left alone; a remote ref is never touched.
 */
export function undoPlan(entry: JournalEntry, now: RefState): UndoPlan {
  const notes: string[] = []
  const restorable: RefMove[] = []

  for (const move of entry.moves) {
    if (!isLocal(move.ref)) {
      notes.push(`${shortRef(move.ref)} : déjà sur le dépôt distant, non annulable ici (il faudrait un push forcé)`)
      continue
    }

    if ((now.refs[move.ref] ?? null) !== move.after) {
      notes.push(`${shortRef(move.ref)} a bougé depuis : laissé tel quel`)
      continue
    }

    restorable.push(move)
  }

  const { before, after } = entry.head
  const isHeadMoved = before.branch !== after.branch || (before.branch === null && before.hash !== after.hash)
  const isHeadAsLeft = now.head.branch === after.branch && (after.branch !== null || now.head.hash === after.hash)
  const switchBack = isHeadMoved && isHeadAsLeft && (before.branch !== null || before.hash !== null)

  if (isHeadMoved && !isHeadAsLeft) {
    notes.push('HEAD a changé depuis : laissé où il est')
  }

  const finalBranch = switchBack ? before.branch : now.head.branch
  const finalRef = finalBranch ? `refs/heads/${finalBranch}` : null
  const steps: string[][] = []

  for (const move of restorable) {
    if (move.after === null && move.before !== null) {
      steps.push(['update-ref', move.ref, move.before, ZERO])
    }
  }

  if (switchBack) {
    steps.push(before.branch ? ['switch', before.branch] : ['switch', '--detach', before.hash ?? ''])
  }

  for (const move of restorable) {
    if (move.before !== null && move.after !== null && move.ref !== finalRef) {
      steps.push(['update-ref', move.ref, move.before, move.after])
    }
  }

  for (const move of restorable) {
    if (move.before === null && move.after !== null) {
      if (move.ref === finalRef) {
        notes.push(`${shortRef(move.ref)} est la branche courante : gardée`)
      } else {
        steps.push(['update-ref', '-d', move.ref, move.after])
      }
    }
  }

  const current = restorable.find(move => move.ref === finalRef && move.before !== null && move.after !== null)

  if (current?.before) {
    steps.push(['reset', keepsFiles(entry.command) ? '--soft' : '--keep', current.before])
  }

  return { steps, notes, restore: entry.saved ? ['stash', 'apply', entry.saved] : null }
}
