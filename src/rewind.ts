// Rewinding git to before a turn of the conversation: what Claude Code's
// /rewind does for files, done for the refs the journal saw move. Each local
// branch and tag the turns touched goes back to where it stood before the
// first of them, HEAD back to its branch or commit, and only through the
// writes the undo already uses (update-ref checked against the current value,
// reset --keep, switch). A remote ref is never touched; a ref moved outside
// the journal is left as it is.

import type { CtreeHead } from '../types'
import * as Cmd from './git-commands'
import { parseLog } from './git-parse'
import type { CommitsShown } from './i18n'
import { type JournalEntry, JOURNAL_SIZE, type RefState, shortRef, ZERO } from './journal'
import type { GitRunner } from './types'

/** One local ref the rewind puts back: where it is, where it goes (null: it goes). */
export type RefBack = { ref: string; now: string | null; target: string | null }

export type RewindPlan = {
  turn: number
  /** The start of that turn's prompt, when the journal kept it. */
  prompt: string | null
  /** The commands, in order: the one that touches the files first, then refs alone. */
  steps: string[][]
  /** `stash apply` of the oldest copy the guard saved in those turns, offered on top. */
  restore: string[] | null
  /** Saved copies besides that one, each still brought back from its own entry. */
  otherCopies: number
  /** The local refs that move, and HEAD from and to. */
  refs: RefBack[]
  head: { now: CtreeHead; target: CtreeHead } | null
  /** Remote refs that moved in those turns (pushes): never touched, said. */
  pushed: { ref: string; before: string | null; now: string | null }[]
  /** What is left alone, and why. */
  left: Left[]
  /** The entries it puts back. */
  entries: string[]
}

export type Left =
  | { kind: 'moved-outside'; ref: string }
  | { kind: 'head-outside' }
  | { kind: 'elsewhere'; ref: string }
  | { kind: 'current-kept'; ref: string }

export type RewindRefusal = { kind: 'incomplete' } | { kind: 'nothing' }

const isLocal = (ref: string) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')

/** Where an entry left a ref: after it, or before it once undone. */
const leftAt = <T>(entry: JournalEntry, before: T, after: T): T => (entry.isUndone ? before : after)

const sameHead = (a: CtreeHead, b: CtreeHead) => (a.branch !== null ? a.branch === b.branch : b.branch === null && a.hash === b.hash)

/** One turn as the journal draws it: a run of consecutive entries of that turn, newest first. */
export type TurnGroup = { turn: number; prompt: string | null; entries: JournalEntry[] }

/**
 * The journal by turn, newest first. A group is a run of consecutive entries
 * of one turn: after Claude Code's /rewind the conversation's turns count
 * again from where it went back, so a turn's number can come back, and the
 * runs keep the two apart.
 */
export function turnGroups(journal: readonly JournalEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = []

  for (const entry of journal) {
    const group = groups[groups.length - 1]

    if (group && group.turn === entry.turn) {
      group.entries.push(entry)
      group.prompt ??= entry.prompt ?? null
    } else {
      groups.push({ turn: entry.turn, prompt: entry.prompt ?? null, entries: [entry] })
    }
  }

  return groups
}

/** The oldest entry of a group: where a rewind to before that turn starts. */
export const groupStart = (group: TurnGroup): JournalEntry | undefined => group.entries[group.entries.length - 1]

/**
 * Where a rewind to before `turn` starts once Claude Code's /rewind went
 * back there: the oldest of the newest entries whose turn is `turn` or later,
 * walking back from the newest until an earlier turn.
 */
export function rewindStart(journal: readonly JournalEntry[], turn: number): string | null {
  let start: string | null = null

  for (const entry of journal) {
    if (entry.turn < turn) break
    start = entry.id
  }

  return start
}

/**
 * How to put git back to where it stood before the entry `start`, from the
 * journal and the refs `now`: every entry from it to the newest is undone at
 * once. For each local ref they touched: its value before the first of them,
 * unless it no longer stands where the last of them left it (moved outside
 * the journal: left alone). HEAD likewise. `elsewhere` names the branches
 * checked out in other worktrees, which are left alone.
 */
export function rewindPlan(
  journal: readonly JournalEntry[],
  start: string,
  now: RefState,
  elsewhere: readonly string[] = [],
): RewindPlan | RewindRefusal {
  const at = journal.findIndex(entry => entry.id === start)

  if (at === -1) return { kind: 'nothing' }

  // The journal keeps the newest entries: when full, its oldest turn may have lost some.
  if (journal.length >= JOURNAL_SIZE && at === journal.length - 1) return { kind: 'incomplete' }

  const entries = journal.slice(0, at + 1).reverse()
  const first = entries[0]
  const last = entries[entries.length - 1]

  if (!first || !last) return { kind: 'nothing' }

  const turn = first.turn

  const left: Left[] = []
  const chains = new Map<string, { target: string | null; expected: string | null }>()

  for (const entry of entries) {
    for (const move of entry.moves) {
      const chain = chains.get(move.ref)

      chains.set(move.ref, { target: chain ? chain.target : move.before, expected: leftAt(entry, move.before, move.after) })
    }
  }

  const refs: RefBack[] = []
  const pushed: RewindPlan['pushed'] = []

  for (const [ref, { target, expected }] of chains) {
    const current = now.refs[ref] ?? null

    if (!isLocal(ref)) {
      if (current !== target) pushed.push({ ref, before: target, now: current })
      continue
    }

    if (current === target) continue

    if (current !== expected) {
      left.push({ kind: 'moved-outside', ref })
      continue
    }

    if (ref.startsWith('refs/heads/') && elsewhere.includes(shortRef(ref))) {
      left.push({ kind: 'elsewhere', ref })
      continue
    }

    refs.push({ ref, now: current, target })
  }

  // HEAD: back to where it stood before the turn, if it is where the journal last saw it.
  const headTarget = first.head.before
  const headExpected = leftAt(last, last.head.before, last.head.after)
  const isHeadOurs = sameHead(headExpected, now.head)

  if (!isHeadOurs && !sameHead(headTarget, now.head)) left.push({ kind: 'head-outside' })

  const steps: string[][] = []
  const take = (ref: string) => {
    const index = refs.findIndex(one => one.ref === ref)
    const [back] = index === -1 ? [] : refs.splice(index, 1)

    return back
  }
  const moved: RefBack[] = []
  let head: RewindPlan['head'] = null

  // The command that touches the files goes first: if git refuses it, nothing else has run.
  if (isHeadOurs && headTarget.branch !== null && headTarget.branch !== now.head.branch) {
    const ref = `refs/heads/${headTarget.branch}`
    const back = take(ref)

    if (back && back.target !== null) {
      steps.push(['update-ref', ref, back.target, back.now ?? ZERO])
      moved.push(back)
    }

    steps.push(['switch', headTarget.branch])
    head = { now: now.head, target: headTarget }
  } else if (isHeadOurs && headTarget.branch === null && headTarget.hash !== null && !sameHead(headTarget, now.head)) {
    steps.push(['switch', '--detach', headTarget.hash])
    head = { now: now.head, target: headTarget }
  } else if (now.head.branch !== null) {
    // HEAD stays on its branch: that branch goes back with reset --keep, never update-ref.
    const ref = `refs/heads/${now.head.branch}`
    const back = take(ref)

    if (back?.target) {
      steps.push(['reset', '--keep', back.target])
      moved.push(back)
      head = { now: now.head, target: { branch: now.head.branch, hash: back.target } }
    } else if (back) {
      left.push({ kind: 'current-kept', ref })
    }
  }

  for (const back of refs) {
    if (back.target === null) {
      if (back.now !== null) steps.push(['update-ref', '-d', back.ref, back.now])
    } else {
      steps.push(['update-ref', back.ref, back.target, back.now ?? ZERO])
    }

    moved.push(back)
  }

  const copies = entries.flatMap(entry => (entry.saved && !entry.isRewind ? [entry.saved] : []))
  const [oldestCopy] = copies

  return {
    turn,
    prompt: entries.find(entry => entry.turn === turn && entry.prompt)?.prompt ?? null,
    steps,
    restore: oldestCopy ? ['stash', 'apply', oldestCopy] : null,
    otherCopies: Math.max(0, copies.length - 1),
    refs: moved,
    head,
    pushed,
    left,
    entries: entries.filter(entry => !entry.isRewind).map(entry => entry.id),
  }
}

/** What the rewind loses and what the remote keeps, read from git before it runs. */
export type RewindLosses = {
  /** Commits no local branch or tag, nor any remote branch, will hold. */
  orphaned: CommitsShown | null
  /** Per pushed remote ref: the commits it holds that no local ref will. */
  kept: { ref: string; commits: CommitsShown | null }[]
}

/**
 * The commits the rewind leaves on no branch: reachable from where the
 * moving refs (and HEAD) stand now, not from where every local ref will
 * stand, nor from any remote branch. And for each pushed remote ref, what it
 * holds that no local ref will. The revisions go on stdin, as a big
 * repository's refs would not fit on a command line.
 */
export async function rewindLosses(git: GitRunner, toplevel: string, plan: RewindPlan, now: RefState): Promise<RewindLosses> {
  const after = new Map(Object.entries(now.refs).filter(([ref]) => isLocal(ref)))

  for (const back of plan.refs) {
    if (back.target === null) after.delete(back.ref)
    else after.set(back.ref, back.target)
  }

  const locals = [...after.values(), ...(plan.head?.target.hash ? [plan.head.target.hash] : [])]
  const remotes = Object.entries(now.refs).flatMap(([ref, hash]) => (ref.startsWith('refs/remotes/') ? [hash] : []))
  const read = async (from: readonly string[], not: readonly string[]): Promise<CommitsShown | null> => {
    if (from.length === 0) return null

    const stdin = [...new Set(from)].map(hash => `${hash}\n`).join('') + [...new Set(not)].map(hash => `^${hash}\n`).join('')
    const result = await git(Cmd.logFromStdin(), { cwd: toplevel, stdin })

    if (result.code !== 0) return null

    const commits = parseLog(result.stdout)

    return commits.length === 0
      ? null
      : { count: commits.length, isCut: commits.length > 50, named: commits.slice(0, 2).map(commit => `${commit.hash.slice(0, 7)} ${commit.subject}`) }
  }
  const moving = [...plan.refs.flatMap(back => (back.now ? [back.now] : [])), ...(plan.head?.now.hash ? [plan.head.now.hash] : [])]
  const [orphaned, ...kept] = await Promise.all([
    read(moving, [...locals, ...remotes]),
    ...plan.pushed.map(push => read(push.now ? [push.now] : [], locals)),
  ])

  return { orphaned: orphaned ?? null, kept: plan.pushed.map((push, i) => ({ ref: push.ref, commits: kept[i] ?? null })) }
}

/** The files the working tree's changes and the move of HEAD both touch: what reset --keep or switch would refuse over. */
export async function rewindConflicts(git: GitRunner, toplevel: string, plan: RewindPlan, changed: readonly string[]): Promise<string[]> {
  const from = plan.head?.now.hash
  const to = plan.head?.target.hash

  if (!from || !to || from === to || changed.length === 0) return []

  const result = await git(Cmd.namesBetween(from, to), { cwd: toplevel })
  const between = new Set(result.stdout.split('\0').filter(Boolean))

  return changed.filter(path => between.has(path))
}
