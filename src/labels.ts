// The labels drawn beside a commit: its branches, remote branches and tags.
// A local branch and its remote counterpart at the same commit are one label
// (`main ⇄ origin`); HEAD's branch comes first, a detached HEAD has its own.

import type { HeadState, Ref, Worktree } from './types'

export type Label =
  | {
      kind: 'branch'
      name: string
      /** The remote branch merged into this label (`origin`, or `origin/other`). */
      remote?: string
      isHead: boolean
      /** Checked out in another worktree. */
      isElsewhere: boolean
    }
  | { kind: 'remote'; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'detached' }

/** Every commit's labels, in drawing order. */
export function labelsByCommit(input: {
  refs: readonly Ref[]
  head: HeadState
  worktrees: readonly Worktree[]
  toplevel: string
}): Map<string, Label[]> {
  const out = new Map<string, Label[]>()
  const add = (hash: string, label: Label) => {
    const list = out.get(hash) ?? []

    list.push(label)
    out.set(hash, list)
  }

  const remotes = input.refs.filter(ref => ref.kind === 'remote')
  const used = new Set<string>()
  const elsewhere = new Set(
    input.worktrees
      .filter(tree => tree.branch && !samePath(tree.path, input.toplevel))
      .map(tree => tree.branch ?? ''),
  )
  const headBranch = input.head.kind === 'branch' ? input.head.branch : null

  if (input.head.kind === 'detached') {
    add(input.head.hash, { kind: 'detached' })
  }

  const branches = input.refs
    .filter(ref => ref.kind === 'branch')
    .sort((a, b) => Number(b.name === headBranch) - Number(a.name === headBranch) || a.name.localeCompare(b.name))

  for (const branch of branches) {
    const twin = twinOf(branch, remotes, used)
    const label: Label = {
      kind: 'branch',
      name: branch.name,
      isHead: branch.name === headBranch,
      isElsewhere: elsewhere.has(branch.name),
    }

    if (twin) {
      used.add(twin.name)
      label.remote = twin.name === `${remoteOf(twin.name)}/${branch.name}` ? remoteOf(twin.name) : twin.name
    }

    add(branch.target, label)
  }

  for (const remote of remotes) {
    if (!used.has(remote.name)) {
      add(remote.target, { kind: 'remote', name: remote.name })
    }
  }

  for (const tag of input.refs.filter(ref => ref.kind === 'tag')) {
    add(tag.target, { kind: 'tag', name: tag.name })
  }

  return out
}

/** The text a label shows. */
export function labelText(label: Label): string {
  switch (label.kind) {
    case 'branch':
      return `${label.name}${label.remote ? ` ⇄ ${label.remote}` : ''}${label.isElsewhere ? ' (wt)' : ''}`
    case 'remote':
      return label.name
    case 'tag':
      return `◇ ${label.name}`
    case 'detached':
      return 'HEAD détachée'
  }
}

/** The refs pointing at each commit, for colouring lines by branch. */
export function refsByCommit(refs: readonly Ref[]): Map<string, Ref[]> {
  const out = new Map<string, Ref[]>()

  for (const ref of refs) {
    out.set(ref.target, [...(out.get(ref.target) ?? []), ref])
  }

  return out
}

/** The remote branch at the same commit: its upstream, else one of the same name. */
function twinOf(branch: Ref, remotes: readonly Ref[], used: ReadonlySet<string>): Ref | undefined {
  const free = remotes.filter(remote => remote.target === branch.target && !used.has(remote.name))

  return (
    free.find(remote => remote.name === branch.upstream) ??
    (branch.upstream ? undefined : free.find(remote => remote.name.slice(remote.name.indexOf('/') + 1) === branch.name))
  )
}

function remoteOf(name: string): string {
  return name.slice(0, name.indexOf('/'))
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}
