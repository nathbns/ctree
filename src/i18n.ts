// Every string the person sees, in English and in French, and the notes
// Claude reads, always in English. The language is set once a session starts:
// from the plugin's `language` option, else Claude Code's own `language`
// setting, else the locale. The keys are the same in both languages.

export type Language = 'en' | 'fr'

export const LANGUAGES: readonly Language[] = ['en', 'fr']

let current: Language = 'en'

export function setLanguage(language: Language): void {
  current = language
}

export function language(): Language {
  return current
}

/** The strings of the language set. */
export function t(): Messages {
  return messages(current)
}

export function messages(language: Language): Messages {
  return language === 'fr' ? FR : EN
}

export type Locale = { LC_ALL?: string | undefined; LC_MESSAGES?: string | undefined; LANG?: string | undefined }

/**
 * The language to draw in. `en` and `fr` as set; `auto` (or anything else)
 * follows Claude Code's `language` setting when it holds one (`french`,
 * `français`, `fr`), else the locale as POSIX reads it (LC_ALL, then
 * LC_MESSAGES, then LANG). English unless French.
 */
export function resolveLanguage(setting: string | undefined, claude: string | undefined, locale: Locale): Language {
  if (setting === 'en' || setting === 'fr') return setting

  const named = claude?.trim()

  if (named) return /^(fr|french|fran[cç]ais)\b/i.test(named) ? 'fr' : 'en'

  const tag = [locale.LC_ALL, locale.LC_MESSAGES, locale.LANG].find(value => value && value.trim() !== '') ?? ''

  return /^fr([_.@-]|$)/i.test(tag) ? 'fr' : 'en'
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const pluriel = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`

/** What git-actions says about a list of commits: how many, and the first ones. */
export type CommitsShown = { count: number; isCut: boolean; named: readonly string[] }

const files = (list: readonly string[]) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}`

const EN = {
  date: {
    now: '<1m',
    minutes: (n: number) => `${n}m`,
    hours: (n: number) => `${n}h`,
    days: (n: number) => `${n}d`,
    weeks: (n: number) => `${n}w`,
    months: (n: number) => `${n}mo`,
    years: (n: number) => `${n}y`,
    /** A duration in seconds, one decimal. */
    seconds: (s: number) => `${s.toFixed(1)}s`,
  },
  binary: 'binary',
  detached: 'detached HEAD',
  row: {
    noMessage: '(no message)',
    wip: (count: number) => `Uncommitted changes (${count})`,
    fold: (count: number, who: string) => `▸ ${count} commits${who ? ` · ${who}` : ''}`,
    detachedAt: (short: string) => `detached HEAD @ ${short}`,
    noCommit: 'no commits yet',
    upstreamGone: (upstream: string) => `${upstream} gone`,
    firstParent: ' · first parent',
    search: (query: string, where: string) => `⌕ "${query}" ${where}`,
    none: 'none',
    overview: '▤ overview',
    linkedWorktree: 'linked worktree',
    session: (count: number) => `✦ ${count} this session`,
  },
  list: {
    loading: 'loading…',
    error: (message: string) => `error: ${message}`,
    noFiles: 'no files changed',
    loadingMore: 'loading more commits…',
  },
  ask: {
    commit: (isMerge: boolean, short: string, subject: string, author: string, date: string) =>
      `Explain ${isMerge ? 'the merge' : 'the commit'} ${short} "${subject}" (${author}, ${date} UTC): what it changes, why, ` +
      `and what to watch out for. Read it with git show ${short}.`,
    range: (count: number, oldest: string, oldestSubject: string, newest: string, newestSubject: string) =>
      `Explain these ${count} commits, from ${oldest} "${oldestSubject}" to ${newest} "${newestSubject}": what they change together and why. ` +
      `Read them with git log -p ${oldest}~1..${newest}.`,
    stash: (selector: string, short: string, subject: string) =>
      `Explain the stash ${selector} (${short}) "${subject}": what it holds, and whether it is worth applying. Read it with git stash show -p ${short}.`,
    compareWipFile: (path: string, from: string, subject: string, diff: string) =>
      `Explain what changes in ${path} between ${from} "${subject}" and my uncommitted changes (${diff}).`,
    compareWip: (from: string, subject: string, diff: string) =>
      `Compare my uncommitted changes with ${from} "${subject}": what changed since and why. Read it with ${diff}.`,
    compareFile: (path: string, from: string, fromSubject: string, to: string, toSubject: string, diff: string) =>
      `Explain what changes in ${path} from ${from} "${fromSubject}" to ${to} "${toSubject}": what and why. Read it with ${diff}.`,
    compare: (from: string, fromSubject: string, to: string, toSubject: string) =>
      `Compare ${from} "${fromSubject}" and ${to} "${toSubject}": what changed from one to the other, why, and what to watch out for. ` +
      `Read the commits with git log --oneline ${from}...${to} and the changes with git diff --stat ${from} ${to}.`,
    file: (path: string, short: string, subject: string) =>
      `Explain the changes to ${path} in commit ${short} "${subject}": what they do and why. Read them with git show ${short} -- ${path}.`,
    wipFile: (path: string) =>
      `Explain my uncommitted changes to ${path} (git diff HEAD -- ${path}): what they change and whether anything is missing.`,
    wip: (count: number) =>
      `Explain my ${count} uncommitted changes (git status, git diff HEAD): what they change and whether anything is missing before committing.`,
    pr: (branches: readonly string[], commits: number, files: number, added: number, deleted: number, base: string) =>
      `Write the pull request description for what this session changed` +
      (branches.length ? ` (branches ${branches.join(', ')})` : '') +
      `: ${commits} commits, ${files} files (+${added} −${deleted}). Read them with git log and git diff ${base}..HEAD. ` +
      'Give a title, a summary, the list of changes and what to check.',
  },
  action: {
    kept: (dirty: number) => `${plural(dirty, 'uncommitted change', 'uncommitted changes')}: git keeps them if it can, else it refuses.`,
    switchTitle: (branch: string) => `⎇ Switch to ${branch}`,
    switchConfirm: 'switch',
    switched: (branch: string) => `✓ On ${branch}`,
    trackTitle: (branch: string, remote: string) => `⎇ Create ${branch} from ${remote} and switch to it`,
    trackDetail: (branch: string, remote: string) => `new local branch ${branch}, tracking ${remote}`,
    trackConfirm: 'create and switch',
    tracked: (branch: string, remote: string) => `✓ On ${branch} (tracking ${remote})`,
    detachTitle: (short: string) => `⎇ Detach HEAD at ${short}`,
    detachDetail: 'Detached HEAD: a commit made here will belong to no branch.',
    detachConfirm: 'detach',
    detached: (short: string) => `✓ HEAD detached at ${short}`,
    stashTitle: (selector: string, subject: string) => `≡ Apply ${selector} "${subject}"`,
    stashDetail: 'its changes come back into the working tree; the stash stays in the list',
    stashDirty: (dirty: number) => `${plural(dirty, 'uncommitted change', 'uncommitted changes')}: git refuses if it would overwrite them`,
    stashConfirm: 'apply',
    stashed: (selector: string) => `✓ ${selector} applied`,
    tagNoName: 'give the tag a name',
    tagTaken: (name: string) => `tag ${name} already exists`,
    tagBadName: 'git refuses this name: no spaces, no .. ~ ^ : ? * [ \\, no - or . at the start',
    tagTitle: (name: string, short: string) => `◇ Create tag ${name} on ${short}`,
    tagSubject: (subject: string) => `"${subject}"`,
    tagDetail: 'annotated tag: it goes with the next push',
    tagConfirm: 'create',
    tagged: (name: string, short: string) => `✓ Tag ${name} created on ${short}`,
  },
  push: {
    cannot: '↑ Cannot push',
    detached: 'Detached HEAD: no branch to push.',
    noCommit: 'No commits to push.',
    noRemote: 'No remote: add one with git remote add.',
    notRemote: (branch: string, upstream: string) => `${branch} tracks ${upstream}, which is not a remote branch.`,
    behind: (upstream: string, behind: number) => `${upstream} has ${plural(behind, 'commit', 'commits')} you don’t have: get them first (no force push).`,
    unreachable: (remote: string, why: string) => `${remote} unreachable: ${why}`,
    lsRemoteFailed: 'git ls-remote failed',
    upToDateTitle: '↑ Already up to date',
    upToDate: (upstream: string) => `Nothing to push: ${upstream} is up to date.`,
    count: (count: number) => (count > 50 ? 'more than 50 commits' : count === 0 ? 'no commits' : plural(count, 'commit', 'commits')),
    title: (branch: string, remote: string, remoteBranch: string) => `↑ Push ${branch} to ${remote}/${remoteBranch}`,
    creates: (remote: string, remoteBranch: string) => `creates ${remote}/${remoteBranch} and tracks it (-u)`,
    commits: (count: string, shown: readonly string[]) => `${count}${shown.length ? ': ' : ''}${shown.join(' · ')}`,
    tags: (tags: readonly string[]) => `${plural(tags.length, 'tag', 'tags')}: ${tags.join(', ')}`,
    confirm: 'push',
    pushed: (branch: string, remote: string, remoteBranch: string) => `✓ Pushed: ${branch} → ${remote}/${remoteBranch}`,
    preparing: '↑ Preparing the push…',
  },
  loss: {
    commits: (commits: CommitsShown) =>
      `${commits.isCut ? 'more than 50 commits' : plural(commits.count, 'commit', 'commits')} (${commits.named.join(' · ')}${commits.count > 2 ? ' · …' : ''})`,
    orphaned: (commits: string) => `${commits} will no longer be on any branch`,
    changes: (list: readonly string[]) => `${plural(list.length, 'changed file', 'changed files')} lost: ${files(list)}`,
    untracked: (list: readonly string[]) => `${plural(list.length, 'untracked file', 'untracked files')} deleted, with no copy possible: ${files(list)}`,
    stashes: (list: readonly string[]) => `${plural(list.length, 'stash', 'stashes')} lost: ${list.slice(0, 2).join(' · ')}`,
    remoteLoses: (remote: string, branch: string, commits: string) => `${remote}/${branch} loses ${commits}`,
    remoteRewritten: (targets: readonly string[]) => `rewrites ${targets.join(', ') || 'the remote branch'} (remote state not checked)`,
    remoteDeleted: (remote: string, branch: string, commits: string | null) => `deletes ${remote}/${branch}${commits ? `: ${commits} exist only there` : ''}`,
    branchOnly: (branch: string, commits: string) => `${branch}: ${commits} exist only on it`,
    rewrite: 'rewrites the whole history',
    reflog: 'erases the reflog, git’s safety net',
    prune: 'deletes for good the commits nothing refers to any more',
    deleteRef: (ref: string) => `deletes the ref ${ref}`.trim(),
    elsewhere: (command: string) => `in another repository (${command}): what it loses was not checked`,
    unchecked: (command: string) => `${command}: what it loses could not be checked`,
  },
  guard: {
    question: (command: string, lines: readonly string[]) => `Claude wants to run "${command}". ${lines.join('; ')}. Let it run?`,
    cut: (question: string) => `${question.slice(0, 590)}… Let it run?`,
    letItRun: 'Let it run',
    refuse: 'Refuse',
    bandTitle: (command: string) => `⚠ Claude wants to run "${command}"`,
    bandHint: '  Answer in Claude Code’s question.',
  },
  journal: {
    headMoved: (before: string, after: string) => `HEAD: ${before} → ${after}`,
    detachedAt: (short: string) => `detached ${short}`,
    created: (name: string) => `${name} created`,
    deleted: (name: string, was: string) => `${name} deleted (was ${was})`,
    saved: (count: number) => `${plural(count, 'changed file', 'changed files')} saved first`,
    onRemote: (ref: string) => `${ref}: already on the remote, cannot be undone here (it would take a force push)`,
    movedSince: (ref: string) => `${ref} moved since: left as it is`,
    headMovedSince: 'HEAD moved since: left where it is',
    currentKept: (ref: string) => `${ref} is the current branch: kept`,
    title: (count: number) => `⟲ Journal of Claude’s git commands · ${count}`,
    empty: '  Claude has not changed anything with git in this session yet.',
    entry: (turn: number, command: string, isSubagent: boolean, isUndone: boolean, when: string) =>
      `turn ${turn} · ${command}${isSubagent ? ' · subagent' : ''}${isUndone ? ' · undone' : ''} · ${when}`,
    nothing: 'nothing changed',
  },
  undo: {
    title: (command: string, turn: number) => `⟲ Undo "${command}" (turn ${turn})`,
    withFiles: (title: string) => `${title}, files included`,
    filesOnly: (command: string) => `⟲ Recover the files "${command}" threw away`,
    filesDetail: (count: number) => `recovers ${plural(count, 'changed file', 'changed files')} thrown away (git stash apply)`,
    confirm: 'undo',
    done: '✓ Undone',
    doneWithFiles: '✓ Undone, files recovered',
    nothingLeft: 'nothing left to put back',
    nothing: 'Nothing to undo: Claude has not changed anything with git yet',
    already: 'Already undone',
  },
  session: {
    title: (since: string | null) => `✦ This session${since ? ` · started ${since} ago` : ''}`,
    reading: '  Reading the session…',
    refs: (count: number) => `  Branches and tags · ${count}`,
    new: (short: string) => `new (${short})`,
    deleted: (short: string) => `deleted (was ${short})`,
    nothingMoved: '    nothing moved',
    commits: (count: number) => `  Commits ✦ · ${count}`,
    none: '    none',
    files: (count: number, added: number, deleted: number) => `  Files HEAD changed · ${count}${count ? ` · +${added} −${deleted}` : ''}`,
    noRepo: 'no git repository here',
  },
  compare: {
    wip: 'the uncommitted changes',
    more: (short: string, count: number) => `${short} has ${plural(count, 'more commit', 'more commits')}`,
    lacks: (short: string, count: number) => `${short} has ${count} the other lacks`,
    files: (count: number, added: number, deleted: number) => `${plural(count, 'file', 'files')}${count ? ` +${added} −${deleted}` : ''}`,
    reading: '  Reading the differences…',
    none: '  No difference in content.',
    others: (count: number) => `  … and ${count} more: git diff --stat`,
  },
  search: {
    words: { message: 'message', author: 'author', hash: 'hash', path: 'file' },
    missed: (words: string) => ` · ${words}: too slow, not searched`,
    title: (query: string, found: number | null, isCut: boolean, missed: string) =>
      `⌕ "${query}" · ${found === null ? 'searching…' : found === 0 ? 'nothing found' : plural(found, 'commit', 'commits')}${isCut ? ' (the newest)' : ''}${missed}`,
    reading: '  Reading the history…',
    none: '  No commit matches, in the message, the author, the hash or the files.',
    field: '⌕ Search',
    noField: '  Searching needs a text field, missing here.',
    placeholder: 'message, author, hash or file',
    submit: 'search',
    hint: '  ⏎ search · Esc cancel · across every branch, case ignored',
  },
  tagForm: {
    title: (short: string, subject: string) => `◇ New tag on ${short} "${subject}"`,
    noField: '  Creating a tag needs a text field, missing here.',
    name: 'Name',
    message: 'Message',
    placeholder: 'tag message',
    submit: 'ok',
    hint: '  ⏎ ok · Tab next field · Esc cancel',
  },
  band: {
    running: (command: string) => `  ${command} running…`,
    cancel: 'cancel',
    close: 'close',
    stepsDone: (done: number, total: number, command: string) => `${done} of ${total} steps done before: ${command} failed`,
    exited: (code: number) => `git exited with code ${code}`,
  },
  notice: {
    slow: (seconds: string) => `Slow repository (${seconds} to read) · git commit-graph write --reachable often speeds it up`,
    band: 'Full width above the prompt · Ctrl+X Tab (or a click) to drive it · z to go back to the pane',
    stash: 'A stash: ⏎ its files, a to apply it, e to explain it',
    notFound: 'Commit not found in the history',
    far: 'Commit far back in the history: shown in focus · f to see every branch again',
    ready: 'Question ready in the prompt · Esc to go there, the pane stays open',
    notFilled: 'The prompt could not be filled here',
    followWhat: 'Select a commit or a branch to follow',
    noCommit: 'No commits yet',
    copyWhat: 'Select a commit to copy its hash',
    copied: (hash: string) => `✓ Copied: ${hash}`,
    notCopied: 'The clipboard took nothing here',
    markWhat: 'Select a commit to mark',
    unmarked: 'Mark removed',
    marked: (short: string) => `⚑ ${short} marked · select another commit, then d to compare`,
    howToCompare: 'Mark a commit with m, then d on another to compare them',
    compareWhat: 'Select a commit to compare',
    markGone: 'The marked commit is no longer in the graph',
    otherThanMark: 'Select a commit other than the mark, then d',
    noSearch: 'No search going: g to search',
    stashWhat: 'Select a stash (≡) to apply it',
    switchWhat: 'Select a commit to switch branch',
    alreadyHere: 'HEAD is already on this commit',
    switchTitle: '⎇ Switch branch',
    tagWhat: 'Select a commit to tag',
  },
  view: {
    reading: 'Reading the repository…',
    bare: 'Bare repository: no working tree to show.',
    noRepo: 'No git repository here.',
    waiting: 'The pane updates as soon as a repository exists (git init, git clone).',
    failed: 'git failed',
    retry: 'r to try again.',
    empty: '   No commits yet.',
    gitFailed: (message: string) => `git failed: ${message}`,
    uncommitted: 'uncommitted',
    diffReading: 'Reading the diff…',
    binary: 'Binary file: no text diff.',
    noDiff: 'No difference in content (mode or rename only).',
    diffCut: '… diff cut: the rest with git show.',
  },
  keys: {
    down: '↓',
    up: '↑',
    open: ['open', ''],
    next: ['next', 'next'],
    previous: ['previous', 'prev.'],
    apply: ['apply', 'apply'],
    search: ['search', 'find'],
    explain: ['explain', 'expl.'],
    compare: ['compare', 'comp.'],
    mark: ['mark', 'mark'],
    branch: ['branch', 'br.'],
    push: ['push', 'push'],
    undo: ['undo', '⟲'],
    view: ['view', 'view'],
    focus: ['focus', 'focus'],
    head: ['HEAD', 'HEAD'],
    copy: ['copy', 'copy'],
    journal: ['journal', 'log'],
    session: ['session', 'sess.'],
    tag: ['tag', 'tag'],
    pane: ['pane', 'pane'],
    wide: ['widen', 'wide'],
    reload: ['reload', 'rld'],
    close: ['close', '✕'],
    help: 'help',
    back: 'back',
    scroll: '↑↓ scroll',
    undoThis: '⏎ undo this one',
    undoLast: 'undo the last',
    pr: 'PR description',
    fileDiff: '⏎ file diff',
    showInGraph: '⏎ show in the graph',
    newSearch: 'new search',
  },
  help: {
    title: 'ctree · help',
    sections: [
      ['Moving', [
        ['j k ↓ ↑', 'next, previous commit (the wheel scrolls)'],
        ['⏎', 'open a commit (its files), then a file (its diff)'],
        ['i', 'back to HEAD'],
        ['g', 'search the message, the author, the hash or the files'],
        ['n b', 'next, previous search result; Esc clears the search'],
      ]],
      ['Reading the history', [
        ['v', 'overview: folds the runs of commits with no branching'],
        ['f', 'focus: the commit’s branch, then its first parent alone, then all'],
        ['m', 'mark a commit; d on another compares them'],
        ['d', 'compare with the mark (no mark: with HEAD)'],
        ['y', 'copy the full hash'],
        ['e', 'put a question for Claude in the prompt'],
      ]],
      ['Changing the repository (always confirmed, the command shown)', [
        ['c', 'switch branch'],
        ['t', 'create an annotated tag'],
        ['p', 'push the branch (never forced)'],
        ['a', 'apply the selected stash (it stays in the list)'],
      ]],
      ['What Claude does', [
        ['u', 'undo its last git command'],
        ['l', 'journal of its git commands, each one undoable'],
        ['s', 'what this session changed; e there drafts a PR description'],
      ]],
      ['Display', [
        ['z', 'full width above the prompt (Ctrl+X Tab to drive it), or the pane'],
        ['r', 'read the repository again'],
        ['q Esc', 'close, or go back'],
      ]],
      ['In the graph', [
        ['● ○ ◉', 'commit, merge, HEAD'],
        ['◌ ┊', 'uncommitted changes, linked to HEAD'],
        ['≡', 'stash, on the commit it was made on'],
        ['✦', 'commit made during this session'],
        ['⚑', 'commit marked for a comparison'],
        ['▸ 7 commits', 'run folded by the overview (⏎ unfolds it)'],
        ['main ⇄ origin', 'branch at the same commit as its remote branch'],
        ['↑2 ↓1', 'commits ahead of and behind the remote branch'],
        ['◇ v1.0', 'tag'],
      ]],
    ] as readonly (readonly [string, readonly (readonly [string, string])[]])[],
  },
  repo: {
    unexpected: 'unexpected answer from git rev-parse',
    logFailed: 'git log failed',
    diffTreeFailed: 'git diff-tree failed',
    diffFailed: 'git diff failed',
    noGit: 'git is not installed on this machine',
  },
  pane: {
    description: 'The repository’s git graph in a pane beside the conversation',
    starting: 'ctree: the session is still starting, try again in a moment.',
    inBand: 'ctree is shown above the prompt, full width. Ctrl+X Tab (or a click) to drive it, z to put it back in a pane.',
    notPlaced: (reason: string) => `ctree: ${reason}`,
    back: 'back to the list',
    kept: 'the pane stays open',
    loading: 'ctree is starting…',
    readOnly: (command: string) => `ctree only runs reads here: git ${command} refused`,
    refused: (command: string) => `ctree refuses this write: git ${command}`,
  },
}

export type Messages = typeof EN

const FR: Messages = {
  date: {
    now: '< 1 min',
    minutes: n => `${n} min`,
    hours: n => `${n} h`,
    days: n => `${n} j`,
    weeks: n => `${n} sem`,
    months: n => `${n} mois`,
    years: n => `${n} an${n > 1 ? 's' : ''}`,
    seconds: s => `${s.toFixed(1).replace('.', ',')} s`,
  },
  binary: 'binaire',
  detached: 'HEAD détachée',
  row: {
    noMessage: '(sans message)',
    wip: count => `Modifications non commitées (${count})`,
    fold: (count, who) => `▸ ${count} commits${who ? ` · ${who}` : ''}`,
    detachedAt: short => `HEAD détachée @ ${short}`,
    noCommit: 'aucun commit',
    upstreamGone: upstream => `${upstream} supprimée`,
    firstParent: ' · 1er parent',
    search: (query, where) => `⌕ « ${query} » ${where}`,
    none: 'aucun',
    overview: '▤ vue d’ensemble',
    linkedWorktree: 'worktree secondaire',
    session: count => `✦ ${count} cette session`,
  },
  list: {
    loading: 'chargement…',
    error: message => `erreur : ${message}`,
    noFiles: 'aucun fichier modifié',
    loadingMore: 'chargement des commits suivants…',
  },
  ask: {
    commit: (isMerge, short, subject, author, date) =>
      `Explique ${isMerge ? 'le merge' : 'le commit'} ${short} « ${subject} » (${author}, ${date} UTC) : ce qu'il change, pourquoi, ` +
      `et ce qu'il faut surveiller. Lis-le avec git show ${short}.`,
    range: (count, oldest, oldestSubject, newest, newestSubject) =>
      `Explique ces ${count} commits, de ${oldest} « ${oldestSubject} » à ${newest} « ${newestSubject} » : ce qu'ils changent ensemble et pourquoi. ` +
      `Lis-les avec git log -p ${oldest}~1..${newest}.`,
    stash: (selector, short, subject) =>
      `Explique le stash ${selector} (${short}) « ${subject} » : ce qu'il contient, et s'il vaut la peine de l'appliquer. Lis-le avec git stash show -p ${short}.`,
    compareWipFile: (path, from, subject, diff) =>
      `Explique ce qui change dans ${path} entre ${from} « ${subject} » et mes modifications non commitées (${diff}).`,
    compareWip: (from, subject, diff) =>
      `Compare mes modifications non commitées avec ${from} « ${subject} » : ce qui a changé depuis et pourquoi. Lis-le avec ${diff}.`,
    compareFile: (path, from, fromSubject, to, toSubject, diff) =>
      `Explique ce qui change dans ${path} de ${from} « ${fromSubject} » à ${to} « ${toSubject} » : quoi et pourquoi. Lis-le avec ${diff}.`,
    compare: (from, fromSubject, to, toSubject) =>
      `Compare ${from} « ${fromSubject} » et ${to} « ${toSubject} » : ce qui a changé de l'un à l'autre, pourquoi, ` +
      `et ce qu'il faut surveiller. Lis les commits avec git log --oneline ${from}...${to} et les changements avec git diff --stat ${from} ${to}.`,
    file: (path, short, subject) =>
      `Explique les changements de ${path} dans le commit ${short} « ${subject} » : ce qu'ils font et pourquoi. Lis-les avec git show ${short} -- ${path}.`,
    wipFile: path =>
      `Explique mes modifications non commitées de ${path} (git diff HEAD -- ${path}) : ce qu'elles changent et s'il manque quelque chose.`,
    wip: count =>
      `Explique mes ${count} modifications non commitées (git status, git diff HEAD) : ce qu'elles changent et s'il manque quelque chose avant de committer.`,
    pr: (branches, commits, files, added, deleted, base) =>
      `Rédige la description de pull request de ce que cette session a changé` +
      (branches.length ? ` (branches ${branches.join(', ')})` : '') +
      ` : ${commits} commits, ${files} fichiers (+${added} −${deleted}). Lis-les avec git log et git diff ${base}..HEAD. ` +
      'Donne un titre, un résumé, la liste des changements et ce qu’il faut vérifier.',
  },
  action: {
    kept: dirty => `${pluriel(dirty, 'modification non commitée', 'modifications non commitées')} : git les garde si possible, sinon il refuse.`,
    switchTitle: branch => `⎇ Passer sur ${branch}`,
    switchConfirm: 'basculer',
    switched: branch => `✓ Sur ${branch}`,
    trackTitle: (branch, remote) => `⎇ Créer ${branch} depuis ${remote} et passer dessus`,
    trackDetail: (branch, remote) => `nouvelle branche locale ${branch}, qui suit ${remote}`,
    trackConfirm: 'créer et basculer',
    tracked: (branch, remote) => `✓ Sur ${branch} (suit ${remote})`,
    detachTitle: short => `⎇ Détacher HEAD sur ${short}`,
    detachDetail: 'HEAD détachée : un commit fait ici n’appartiendra à aucune branche.',
    detachConfirm: 'détacher',
    detached: short => `✓ HEAD détachée sur ${short}`,
    stashTitle: (selector, subject) => `≡ Appliquer ${selector} « ${subject} »`,
    stashDetail: 'ses modifications reviennent dans l’arbre de travail ; le stash reste dans la liste',
    stashDirty: dirty => `${pluriel(dirty, 'modification non commitée', 'modifications non commitées')} : git refuse s’il devait les écraser`,
    stashConfirm: 'appliquer',
    stashed: selector => `✓ ${selector} appliqué`,
    tagNoName: 'donne un nom au tag',
    tagTaken: name => `le tag ${name} existe déjà`,
    tagBadName: 'nom refusé par git : ni espace, ni .. ~ ^ : ? * [ \\, ni - ou . au début',
    tagTitle: (name, short) => `◇ Créer le tag ${name} sur ${short}`,
    tagSubject: subject => `« ${subject} »`,
    tagDetail: 'tag annoté : il partira avec le prochain push',
    tagConfirm: 'créer',
    tagged: (name, short) => `✓ Tag ${name} créé sur ${short}`,
  },
  push: {
    cannot: '↑ Push impossible',
    detached: 'HEAD détachée : aucune branche à pousser.',
    noCommit: 'Aucun commit à pousser.',
    noRemote: 'Aucun dépôt distant : ajoute-en un avec git remote add.',
    notRemote: (branch, upstream) => `${branch} suit ${upstream}, qui n’est pas une branche distante.`,
    behind: (upstream, behind) => `${upstream} a ${pluriel(behind, 'commit', 'commits')} que tu n’as pas : récupère-les d’abord (pas de push forcé).`,
    unreachable: (remote, why) => `${remote} injoignable : ${why}`,
    lsRemoteFailed: 'git ls-remote a échoué',
    upToDateTitle: '↑ Déjà à jour',
    upToDate: upstream => `Rien à pousser : ${upstream} est à jour.`,
    count: count => (count > 50 ? 'plus de 50 commits' : count === 0 ? 'aucun commit' : pluriel(count, 'commit', 'commits')),
    title: (branch, remote, remoteBranch) => `↑ Pousser ${branch} vers ${remote}/${remoteBranch}`,
    creates: (remote, remoteBranch) => `crée ${remote}/${remoteBranch} et la suit (-u)`,
    commits: (count, shown) => `${count}${shown.length ? ' : ' : ''}${shown.join(' · ')}`,
    tags: tags => `${pluriel(tags.length, 'tag', 'tags')} : ${tags.join(', ')}`,
    confirm: 'pousser',
    pushed: (branch, remote, remoteBranch) => `✓ Poussé : ${branch} → ${remote}/${remoteBranch}`,
    preparing: '↑ Préparation du push…',
  },
  loss: {
    commits: commits =>
      `${commits.isCut ? 'plus de 50 commits' : pluriel(commits.count, 'commit', 'commits')} (${commits.named.join(' · ')}${commits.count > 2 ? ' · …' : ''})`,
    orphaned: commits => `${commits} ne seront plus sur aucune branche`,
    changes: list => `${pluriel(list.length, 'fichier modifié perdu', 'fichiers modifiés perdus')} : ${files(list)}`,
    untracked: list => `${pluriel(list.length, 'fichier non suivi supprimé', 'fichiers non suivis supprimés')}, sans copie possible : ${files(list)}`,
    stashes: list => `${pluriel(list.length, 'stash perdu', 'stashs perdus')} : ${list.slice(0, 2).join(' · ')}`,
    remoteLoses: (remote, branch, commits) => `${remote}/${branch} perd ${commits}`,
    remoteRewritten: targets => `réécrit ${targets.join(', ') || 'la branche distante'} (état distant non vérifié)`,
    remoteDeleted: (remote, branch, commits) => `supprime ${remote}/${branch}${commits ? ` : ${commits} n’existent que là` : ''}`,
    branchOnly: (branch, commits) => `${branch} : ${commits} n’existent que sur elle`,
    rewrite: 'réécrit tout l’historique',
    reflog: 'efface le reflog, le filet de secours de git',
    prune: 'supprime pour de bon les commits que plus rien ne référence',
    deleteRef: ref => `supprime la référence ${ref}`.trim(),
    elsewhere: command => `dans un autre dépôt (${command}) : ce qu’elle perd n’a pas été vérifié`,
    unchecked: command => `${command} : ce qu’elle perd n’a pas pu être vérifié`,
  },
  guard: {
    question: (command, lines) => `Claude veut lancer « ${command} ». ${lines.join(' ; ')}. Laisser passer ?`,
    cut: question => `${question.slice(0, 590)}… Laisser passer ?`,
    letItRun: 'Laisser passer',
    refuse: 'Refuser',
    bandTitle: command => `⚠ Claude veut lancer « ${command} »`,
    bandHint: '  Réponds dans la question de Claude Code.',
  },
  journal: {
    headMoved: (before, after) => `HEAD : ${before} → ${after}`,
    detachedAt: short => `détachée ${short}`,
    created: name => `${name} créée`,
    deleted: (name, was) => `${name} supprimée (était ${was})`,
    saved: count => `${pluriel(count, 'fichier modifié sauvé', 'fichiers modifiés sauvés')} avant`,
    onRemote: ref => `${ref} : déjà sur le dépôt distant, non annulable ici (il faudrait un push forcé)`,
    movedSince: ref => `${ref} a bougé depuis : laissé tel quel`,
    headMovedSince: 'HEAD a changé depuis : laissé où il est',
    currentKept: ref => `${ref} est la branche courante : gardée`,
    title: count => `⟲ Journal des commandes git de Claude · ${count}`,
    empty: '  Claude n’a encore rien changé avec git dans cette session.',
    entry: (turn, command, isSubagent, isUndone, when) =>
      `tour ${turn} · ${command}${isSubagent ? ' · sous-agent' : ''}${isUndone ? ' · annulé' : ''} · ${when}`,
    nothing: 'rien de changé',
  },
  undo: {
    title: (command, turn) => `⟲ Annuler « ${command} » (tour ${turn})`,
    withFiles: title => `${title}, fichiers compris`,
    filesOnly: command => `⟲ Récupérer les fichiers jetés par « ${command} »`,
    filesDetail: count => `récupère ${pluriel(count, 'fichier modifié jeté', 'fichiers modifiés jetés')} (git stash apply)`,
    confirm: 'défaire',
    done: '✓ Annulé',
    doneWithFiles: '✓ Annulé, fichiers récupérés',
    nothingLeft: 'plus rien à remettre',
    nothing: 'Rien à annuler : Claude n’a encore rien changé avec git',
    already: 'Déjà annulé',
  },
  session: {
    title: since => `✦ Cette session${since ? ` · depuis ${since}` : ''}`,
    reading: '  Lecture de la session…',
    refs: count => `  Branches et tags · ${count}`,
    new: short => `nouvelle (${short})`,
    deleted: short => `supprimée (était ${short})`,
    nothingMoved: '    rien n’a bougé',
    commits: count => `  Commits ✦ · ${count}`,
    none: '    aucun',
    files: (count, added, deleted) => `  Fichiers changés par HEAD · ${count}${count ? ` · +${added} −${deleted}` : ''}`,
    noRepo: 'pas de dépôt git ici',
  },
  compare: {
    wip: 'les modifications non commitées',
    more: (short, count) => `${short} a ${pluriel(count, 'commit', 'commits')} de plus`,
    lacks: (short, count) => `${short} en a ${count} que l’autre n’a pas`,
    files: (count, added, deleted) => `${pluriel(count, 'fichier', 'fichiers')}${count ? ` +${added} −${deleted}` : ''}`,
    reading: '  Lecture des différences…',
    none: '  Aucune différence de contenu.',
    others: count => `  … et ${count} autres : git diff --stat`,
  },
  search: {
    words: { message: 'message', author: 'auteur', hash: 'hash', path: 'fichier' },
    missed: words => ` · ${words} : trop long, non cherché`,
    title: (query, found, isCut, missed) =>
      `⌕ « ${query} » · ${found === null ? 'recherche…' : found === 0 ? 'rien trouvé' : pluriel(found, 'commit', 'commits')}${isCut ? ' (les plus récents)' : ''}${missed}`,
    reading: '  Lecture de l’historique…',
    none: '  Aucun commit ne correspond, dans le message, l’auteur, le hash ou les fichiers.',
    field: '⌕ Chercher',
    noField: '  Chercher demande un champ de texte, absent ici.',
    placeholder: 'message, auteur, hash ou fichier',
    submit: 'chercher',
    hint: '  ⏎ chercher · Échap annuler · dans toutes les branches, majuscules ignorées',
  },
  tagForm: {
    title: (short, subject) => `◇ Nouveau tag sur ${short} « ${subject} »`,
    noField: '  Créer un tag demande un champ de texte, absent ici.',
    name: 'Nom',
    message: 'Message',
    placeholder: 'message du tag',
    submit: 'valider',
    hint: '  ⏎ valider · Tab champ suivant · Échap annuler',
  },
  band: {
    running: command => `  ${command} en cours…`,
    cancel: 'annuler',
    close: 'fermer',
    stepsDone: (done, total, command) =>
      `${done} étape${done > 1 ? 's' : ''} sur ${total} faite${done > 1 ? 's' : ''} avant : ${command} a échoué`,
    exited: code => `git a quitté avec le code ${code}`,
  },
  notice: {
    slow: seconds => `Dépôt lent à lire (${seconds}) · git commit-graph write --reachable l’accélère souvent`,
    band: 'Pleine largeur au-dessus du prompt · Ctrl+X Tab (ou un clic) pour piloter · z pour revenir au panneau',
    stash: 'Un stash : ⏎ ses fichiers, a pour l’appliquer, e pour l’expliquer',
    notFound: 'Commit introuvable dans l’historique',
    far: 'Commit loin dans l’historique : montré en focus · f pour revenir à toutes les branches',
    ready: 'Question prête dans le prompt · Échap pour y aller, le panneau reste ouvert',
    notFilled: 'Le prompt n’a pas pu être rempli ici',
    followWhat: 'Sélectionne un commit ou une branche à suivre',
    noCommit: 'Pas encore de commit',
    copyWhat: 'Sélectionne un commit pour copier son hash',
    copied: hash => `✓ Copié : ${hash}`,
    notCopied: 'Le presse-papiers n’a rien pris ici',
    markWhat: 'Sélectionne un commit à marquer',
    unmarked: 'Marque retirée',
    marked: short => `⚑ ${short} marqué · sélectionne un autre commit, puis d pour comparer`,
    howToCompare: 'Marque un commit avec m, puis d sur un autre pour les comparer',
    compareWhat: 'Sélectionne un commit à comparer',
    markGone: 'Le commit marqué n’est plus dans le graphe',
    otherThanMark: 'Sélectionne un autre commit que la marque, puis d',
    noSearch: 'Aucune recherche en cours : g pour chercher',
    stashWhat: 'Sélectionne un stash (≡) pour l’appliquer',
    switchWhat: 'Sélectionne un commit pour changer de branche',
    alreadyHere: 'HEAD est déjà sur ce commit',
    switchTitle: '⎇ Changer de branche',
    tagWhat: 'Sélectionne un commit à tagger',
  },
  view: {
    reading: 'Lecture du dépôt…',
    bare: 'Dépôt nu : pas d’arbre de travail à montrer.',
    noRepo: 'Pas de dépôt git ici.',
    waiting: 'Le panneau se met à jour dès qu’un dépôt existe (git init, git clone).',
    failed: 'git a échoué',
    retry: 'r pour réessayer.',
    empty: '   Aucun commit pour l’instant.',
    gitFailed: message => `git a échoué : ${message}`,
    uncommitted: 'non commité',
    diffReading: 'Lecture du diff…',
    binary: 'Fichier binaire : pas de diff texte.',
    noDiff: 'Aucune différence de contenu (mode ou renommage seul).',
    diffCut: '… diff tronqué : la suite avec git show.',
  },
  keys: {
    down: '↓',
    up: '↑',
    open: ['ouvrir', ''],
    next: ['suivant', 'suiv.'],
    previous: ['précédent', 'préc.'],
    apply: ['appliquer', 'appl.'],
    search: ['chercher', 'cherch.'],
    explain: ['expliquer', 'expl.'],
    compare: ['comparer', 'comp.'],
    mark: ['marquer', 'marq.'],
    branch: ['branche', 'br.'],
    push: ['push', 'push'],
    undo: ['annuler', '⟲'],
    view: ['vue', 'vue'],
    focus: ['focus', 'focus'],
    head: ['HEAD', 'HEAD'],
    copy: ['copier', 'copie'],
    journal: ['journal', 'journal'],
    session: ['session', 'session'],
    tag: ['tag', 'tag'],
    pane: ['panneau', 'panneau'],
    wide: ['agrandir', 'large'],
    reload: ['maj', 'maj'],
    close: ['fermer', '✕'],
    help: 'aide',
    back: 'retour',
    scroll: '↑↓ défiler',
    undoThis: '⏎ annuler celle-ci',
    undoLast: 'annuler la dernière',
    pr: 'description de PR',
    fileDiff: '⏎ diff du fichier',
    showInGraph: '⏎ voir dans le graphe',
    newSearch: 'nouvelle recherche',
  },
  help: {
    title: 'ctree · aide',
    sections: [
      ['Se déplacer', [
        ['j k ↓ ↑', 'commit suivant, précédent (la molette fait défiler)'],
        ['⏎', 'ouvrir un commit (ses fichiers), puis un fichier (son diff)'],
        ['i', 'revenir à HEAD'],
        ['g', 'chercher dans le message, l’auteur, le hash ou les fichiers'],
        ['n b', 'résultat suivant, précédent de la recherche ; Échap efface la recherche'],
      ]],
      ['Lire l’historique', [
        ['v', 'vue d’ensemble : replie les suites de commits sans embranchement'],
        ['f', 'focus : la branche du commit, puis son 1er parent seul, puis tout'],
        ['m', 'marquer un commit ; d sur un autre les compare'],
        ['d', 'comparer avec la marque (sans marque : avec HEAD)'],
        ['y', 'copier le hash complet'],
        ['e', 'préparer une question pour Claude dans le prompt'],
      ]],
      ['Changer le dépôt (toujours confirmé, la commande affichée)', [
        ['c', 'changer de branche'],
        ['t', 'créer un tag annoté'],
        ['p', 'pousser la branche (jamais en force)'],
        ['a', 'appliquer le stash sélectionné (il reste dans la liste)'],
      ]],
      ['Ce que fait Claude', [
        ['u', 'annuler sa dernière commande git'],
        ['l', 'journal de ses commandes git, chacune annulable'],
        ['s', 'ce que cette session a changé ; e y prépare une description de PR'],
      ]],
      ['Affichage', [
        ['z', 'pleine largeur au-dessus du prompt (Ctrl+X Tab pour le piloter), ou panneau'],
        ['r', 'relire le dépôt'],
        ['q Échap', 'fermer, ou revenir en arrière'],
      ]],
      ['Dans le graphe', [
        ['● ○ ◉', 'commit, merge, HEAD'],
        ['◌ ┊', 'modifications non commitées, reliées à HEAD'],
        ['≡', 'stash, sur le commit où il a été fait'],
        ['✦', 'commit fait pendant cette session'],
        ['⚑', 'commit marqué pour une comparaison'],
        ['▸ 7 commits', 'suite repliée par la vue d’ensemble (⏎ la déplie)'],
        ['main ⇄ origin', 'branche au même commit que sa branche distante'],
        ['↑2 ↓1', 'commits d’avance et de retard sur la branche distante'],
        ['◇ v1.0', 'tag'],
      ]],
    ],
  },
  repo: {
    unexpected: 'réponse inattendue de git rev-parse',
    logFailed: 'git log a échoué',
    diffTreeFailed: 'git diff-tree a échoué',
    diffFailed: 'git diff a échoué',
    noGit: 'git est introuvable sur cette machine',
  },
  pane: {
    description: 'Graphe git du dépôt dans un panneau à côté de la conversation',
    starting: 'ctree : la session démarre encore, réessaie dans un instant.',
    inBand: 'ctree s’affiche au-dessus du prompt, sur toute la largeur. Ctrl+X Tab (ou un clic) pour le piloter, z pour le remettre en panneau.',
    notPlaced: reason => `ctree : ${reason}`,
    back: 'retour à la liste',
    kept: 'le panneau reste ouvert',
    loading: 'ctree démarre…',
    readOnly: command => `ctree ne lance que des lectures ici : git ${command} refusé`,
    refused: command => `ctree refuse cette écriture : git ${command}`,
  },
}

/**
 * What Claude reads, appended to the conversation or in a refusal: always
 * English, whatever the language the person sees.
 */
export const NOTES = {
  switched: (branch: string) => `[ctree] Through the pane, the person switched to branch ${branch} (git switch ${branch}).`,
  tracked: (branch: string, remote: string) =>
    `[ctree] Through the pane, the person created branch ${branch} from ${remote} and switched to it (git switch --track ${remote}).`,
  detached: (short: string) => `[ctree] Through the pane, the person detached HEAD at ${short} (git switch --detach ${short}).`,
  stashApplied: (selector: string, subject: string, short: string) =>
    `[ctree] Through the pane, the person applied the stash ${selector} "${subject}" (git stash apply ${short}): ` +
    'its changes are now in the working tree, and the stash is kept.',
  tagged: (name: string, short: string, subject: string) =>
    `[ctree] Through the pane, the person created the annotated tag ${name} on ${short} "${subject}".`,
  pushed: (branch: string, remote: string, remoteBranch: string, count: string, tags: readonly string[]) =>
    `[ctree] Through the pane, the person pushed ${branch} to ${remote}/${remoteBranch} (${count}${tags.length ? `, tags ${tags.join(', ')}` : ''}).`,
  undone: (command: string, turn: number, what: string, withFiles: boolean) =>
    `[ctree] Through the pane, the person undid your command "${command}" (turn ${turn}): ${what}` +
    `${withFiles ? ', and the changed files it threw away are back' : ''}. The repository is back to how it was before that command.`,
  refused: (command: string, lines: readonly string[]) =>
    `ctree: the person refused "${command}", which would have lost: ${lines.join('; ')}. ` +
    'Do not run this command again as is: ask them how to proceed.',
  unchecked:
    'ctree could not check what this git command would lose: it was not run. Ask the person before trying again.',
}
