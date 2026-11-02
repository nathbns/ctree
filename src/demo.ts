// The demo repository `/ctree demo` builds in a new temporary folder: two
// authors, a remote (a bare repository beside it, as origin), a merge, two
// tags, a local branch, a stash, two commits not pushed yet and changes not
// committed. Every date and name is fixed, so the hashes are the same on
// every machine and screenshots can be taken again.
//
// Its writes have a guard of their own, apart from isAllowedWrite: they go
// only under the folder the demo just created, through git told explicitly
// which repository it works on.

import { isSafeRefName } from './git-actions'

/** The two people of the demo's history. */
export const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' }
export const GRACE = { name: 'Grace Hopper', email: 'grace@example.com' }

type Person = typeof ADA

/** One step of the build: a file of the work tree written, or a git command run in the repository or for the remote. */
export type DemoStep =
  | { kind: 'file'; path: string; text: string }
  | { kind: 'git'; where: 'repo' | 'remote'; args: string[]; by?: Person; at?: string }

/** The folder's base name: `mktemp` replaces the X's. */
export const ROOT_TEMPLATE = 'ctree-demo.XXXXXXXX'

/** The work tree and the bare remote, under the new folder. */
export const repoOf = (root: string): string => `${root}/demo`
export const remoteOf = (root: string): string => `${root}/origin.git`

const GREET_V1 = 'export function greet(name) {\n  return `Hello, ${name}!`\n}\n'
const GREET_V2 =
  "const WORDS = { en: 'Hello', fr: 'Bonjour' }\n\n" +
  'export function greet(name, lang = \'en\') {\n  return `${WORDS[lang] ?? WORDS.en}, ${name}!`\n}\n'
const GREET_V3 = `${GREET_V2}\nexport function farewell(name) {\n  return \`Goodbye, \${name}.\`\n}\n`
const TEST_V1 = "import assert from 'node:assert'\nimport { greet } from '../src/greet.js'\n\nassert.equal(greet('Ada'), 'Hello, Ada!')\n"
const TEST_V2 =
  "import assert from 'node:assert'\nimport { farewell, greet } from '../src/greet.js'\n\n" +
  "assert.equal(greet('Ada'), 'Hello, Ada!')\nassert.equal(greet('Ada', 'fr'), 'Bonjour, Ada!')\nassert.equal(farewell('Ada'), 'Goodbye, Ada.')\n"
const README_V1 = '# greet\n\nA tiny greeting library, for trying ctree.\n'
const README_V2 = `${README_V1}\nPass a language: \`greet('Ada', 'fr')\`.\n`

const commit = (message: string, by: Person, at: string): DemoStep[] => [
  { kind: 'git', where: 'repo', args: ['add', '-A'] },
  { kind: 'git', where: 'repo', args: ['commit', '-q', '-m', message], by, at },
]

/** Every step, in order: the same history every time. */
export function demoSteps(): DemoStep[] {
  return [
    { kind: 'file', path: 'README.md', text: README_V1 },
    { kind: 'git', where: 'repo', args: ['init', '-q', '-b', 'main'] },
    ...commit('Initial commit', ADA, '2026-03-02T09:00:00Z'),
    { kind: 'file', path: 'src/greet.js', text: GREET_V1 },
    ...commit('Add greet()', ADA, '2026-03-02T11:30:00Z'),
    { kind: 'file', path: 'test/greet.test.js', text: TEST_V1 },
    ...commit('Test greet()', GRACE, '2026-03-03T10:00:00Z'),
    { kind: 'git', where: 'repo', args: ['tag', '-a', 'v0.1.0', '-m', 'v0.1.0'], by: ADA, at: '2026-03-03T10:05:00Z' },

    { kind: 'git', where: 'repo', args: ['switch', '-q', '-c', 'feature/lang'] },
    { kind: 'file', path: 'src/greet.js', text: GREET_V2 },
    ...commit('Greet in French too', GRACE, '2026-03-04T14:00:00Z'),
    { kind: 'file', path: 'README.md', text: README_V2 },
    ...commit('Document the language', GRACE, '2026-03-05T09:15:00Z'),

    { kind: 'git', where: 'repo', args: ['switch', '-q', 'main'] },
    { kind: 'file', path: 'CHANGELOG.md', text: '# Changelog\n\n## Unreleased\n\n- greet(name)\n' },
    ...commit('Start a changelog', ADA, '2026-03-05T16:40:00Z'),
    { kind: 'git', where: 'repo', args: ['merge', '-q', '--no-ff', '-m', "Merge branch 'feature/lang'", 'feature/lang'], by: ADA, at: '2026-03-06T10:00:00Z' },
    { kind: 'file', path: 'CHANGELOG.md', text: '# Changelog\n\n## 0.2.0\n\n- greet(name, lang): English and French\n- greet(name)\n' },
    ...commit('Release 0.2.0', ADA, '2026-03-06T10:30:00Z'),
    { kind: 'git', where: 'repo', args: ['tag', '-a', 'v0.2.0', '-m', 'v0.2.0'], by: ADA, at: '2026-03-06T10:35:00Z' },

    // The remote: a bare repository beside the work tree, holding main, its tags and feature/lang.
    { kind: 'git', where: 'remote', args: ['init', '-q', '--bare', '-b', 'main'] },
    { kind: 'git', where: 'repo', args: ['remote', 'add', 'origin', '<remote>'] },
    { kind: 'git', where: 'repo', args: ['push', '-q', '--follow-tags', '-u', 'origin', 'main'] },
    { kind: 'git', where: 'repo', args: ['push', '-q', '-u', 'origin', 'feature/lang'] },

    // A branch never pushed.
    { kind: 'git', where: 'repo', args: ['switch', '-q', '-c', 'feature/cli'] },
    { kind: 'file', path: 'bin/greet.js', text: "#!/usr/bin/env node\nimport { greet } from '../src/greet.js'\n\nconsole.log(greet(process.argv[2] ?? 'world'))\n" },
    ...commit('Sketch a command line', GRACE, '2026-03-07T15:00:00Z'),
    { kind: 'git', where: 'repo', args: ['switch', '-q', 'main'] },

    // Two commits on main, not pushed: what `git reset --hard HEAD~2` would leave on no branch.
    { kind: 'file', path: 'src/greet.js', text: GREET_V3 },
    ...commit('Add farewell()', ADA, '2026-03-09T09:20:00Z'),
    { kind: 'file', path: 'test/greet.test.js', text: TEST_V2 },
    ...commit('Test farewell()', ADA, '2026-03-09T11:45:00Z'),

    // A stash, then changes not committed: one tracked file (which a reset --hard throws away) and a new one.
    { kind: 'file', path: 'README.md', text: `${README_V2}\n![tests](https://img.shields.io/badge/tests-passing-green)\n` },
    { kind: 'git', where: 'repo', args: ['stash', 'push', '-q', '-m', 'README badges'], by: ADA, at: '2026-03-09T12:00:00Z' },
    { kind: 'file', path: 'src/greet.js', text: GREET_V3.replace('Goodbye', 'See you soon') },
    { kind: 'file', path: 'notes.txt', text: 'ideas: greet in Spanish, a --shout flag\n' },
  ]
}

/** A git command as it runs: its arguments, where, and the environment that pins its repository. */
export type DemoRun = { args: string[]; cwd: string; env: Record<string, string> }

/**
 * The run of a git step under `root`. GIT_DIR (and GIT_WORK_TREE) name the
 * demo's repository outright, so git cannot reach another one; the person's
 * own config is left out, so nothing signs, hooks or rewrites what it does.
 */
export function demoRun(root: string, step: DemoStep & { kind: 'git' }): DemoRun {
  const isRepo = step.where === 'repo'
  const person = step.by ?? ADA
  const at = step.at ?? '2026-03-02T09:00:00Z'

  return {
    args: step.args.map(arg => (arg === '<remote>' ? remoteOf(root) : arg)),
    // The bare remote does not exist before its init: it runs from the folder.
    cwd: isRepo ? repoOf(root) : root,
    env: {
      GIT_DIR: isRepo ? `${repoOf(root)}/.git` : remoteOf(root),
      ...(isRepo ? { GIT_WORK_TREE: repoOf(root) } : {}),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: person.name,
      GIT_AUTHOR_EMAIL: person.email,
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: person.name,
      GIT_COMMITTER_EMAIL: person.email,
      GIT_COMMITTER_DATE: at,
    },
  }
}

/** The absolute path of a file step. */
export const demoFile = (root: string, path: string): string => `${repoOf(root)}/${path}`

/**
 * Whether `root` can be a folder the demo made: absolute, plain, named by
 * ROOT_TEMPLATE. The hooks also hold it to the one `mktemp` just returned,
 * empty.
 */
export function isDemoRoot(root: string): boolean {
  const name = root.slice(root.lastIndexOf('/') + 1)

  return root.startsWith('/') && !/\/\.\.?(\/|$)|\/\//.test(root) && /^ctree-demo\.[A-Za-z0-9]{6,}$/.test(name)
}

const MESSAGE = (text: string | undefined) => text !== undefined && text.trim() !== '' && !text.startsWith('-')

/**
 * Whether a run is one the demo builds, under `root` and nowhere else: its
 * folder and repository pinned to the demo's, and its arguments one of these
 * shapes: `init -q -b main`, `init -q --bare -b main` (the remote), `add -A`,
 * `commit -q -m <message>`, `switch -q [-c] <branch>`, `merge -q --no-ff -m
 * <message> <branch>`, `tag -a <name> -m <message>`, `stash push -q -m
 * <message>`, `remote add origin <root>/origin.git`, `push -q [--follow-tags]
 * -u origin <branch>`. Nothing forced, deleted or reset.
 */
export function isDemoRun(root: string, run: DemoRun): boolean {
  if (!isDemoRoot(root)) return false

  const isRepo = run.cwd === repoOf(root) && run.env.GIT_DIR === `${repoOf(root)}/.git` && run.env.GIT_WORK_TREE === repoOf(root)
  const isRemote = run.cwd === root && run.env.GIT_DIR === remoteOf(root) && run.env.GIT_WORK_TREE === undefined

  if (!isRepo && !isRemote) return false

  const [command, ...rest] = run.args
  const is = (...shape: (string | ((arg: string | undefined) => boolean))[]) =>
    rest.length === shape.length && shape.every((part, i) => (typeof part === 'string' ? rest[i] === part : part(rest[i])))
  // Plain names only: a `+` or a `:` would make a refspec force or delete.
  const branch = (arg: string | undefined) => arg !== undefined && /^[A-Za-z0-9][\w./-]*$/.test(arg) && isSafeRefName(arg)

  if (isRemote) return command === 'init' && is('-q', '--bare', '-b', 'main')

  switch (command) {
    case 'init':
      return is('-q', '-b', 'main')
    case 'add':
      return is('-A')
    case 'commit':
      return is('-q', '-m', MESSAGE)
    case 'switch':
      return is('-q', branch) || is('-q', '-c', branch)
    case 'merge':
      return is('-q', '--no-ff', '-m', MESSAGE, branch)
    case 'tag':
      return is('-a', branch, '-m', MESSAGE)
    case 'stash':
      return is('push', '-q', '-m', MESSAGE)
    case 'remote':
      return is('add', 'origin', remoteOf(root))
    case 'push':
      return is('-q', '-u', 'origin', branch) || is('-q', '--follow-tags', '-u', 'origin', branch)
    default:
      return false
  }
}

/** Whether a file write lands in the demo's work tree, outside its .git, under `root`. */
export function isDemoFile(root: string, path: string): boolean {
  const prefix = `${repoOf(root)}/`

  if (!isDemoRoot(root) || !path.startsWith(prefix)) return false

  const segments = path.slice(prefix.length).split('/')

  return segments.every(segment => /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..') && segments[0] !== '.git'
}

/** What runs the steps: the hooks, which hold each run and write to the guard above. */
export type DemoRunner = {
  git: (run: DemoRun) => Promise<{ code: number; stderr: string }>
  file: (path: string, text: string) => Promise<void>
}

/** Builds the demo under `root`, step by step; the first git failure stops it, saying which. */
export async function buildDemo(root: string, runner: DemoRunner, steps: readonly DemoStep[] = demoSteps()): Promise<{ ok: true } | { ok: false; step: string; error: string }> {
  for (const step of steps) {
    if (step.kind === 'file') {
      await runner.file(demoFile(root, step.path), step.text)
      continue
    }

    const result = await runner.git(demoRun(root, step))

    if (result.code !== 0) {
      return { ok: false, step: `git ${step.args.join(' ')}`, error: result.stderr.trim().split('\n')[0] ?? '' }
    }
  }

  return { ok: true }
}

/** What to paste in the demo's session so Claude tries what the guard holds. */
export const DEMO_COMMAND = 'git reset --hard HEAD~2'
