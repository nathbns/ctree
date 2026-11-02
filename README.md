# ctree

**/rewind brings back your files. ctree brings back your git.**

English · [Français](README.fr.md)

A Claude Code mod that shows the repository's git graph in a pane beside the conversation, as close as it gets to VS Code's Source Control graph and the Git Graph extension. It follows the git commands Claude runs live, and marks with a `✦` the commits made during the session. It reads git, and writes only what you confirm: switching branch, creating a tag, pushing, applying a stash, undoing one of Claude's commands.

```
demo · ⎇ main · ✓ origin/main
  ◌     Uncommitted changes (2)
  ┊ ●   Pane: adaptive columns                  feature/ui  Nathan           2h  ed58ff3
  ┊ ●   j/k navigation                                      Nathan           1d  63622de
❯ ◉─┼─╮ Merge branch 'feature/la…  main ⇄ origin  ◇ v0.2.0  Nathan           5h  a2e6115
  │ │ │   A lanes.txt                                                                 +2
  │ │ ● Lane layout: octopus merge  origin/feature/lanes  Léa              6h  42cccc5
  ●─╯ │ Branch labels                                       Nathan           2d  57c5586
  ●───╯ Parse git log                             ◇ v0.1.0  Nathan           3d  deeed04
j: ↓ k: ↑ ⏎ g: find e: expl. d: comp. m: mark c: br. p: push u: ⟲ v: view h: help
```

## Install

At the prompt of a Claude Code session, in a terminal:

```
/plugin install ctree --marketplace nathbns/ctree
```

`y` to add the marketplace, then Enter for the scope (user: ctree is there in all your sessions). It is active right away.

From a shell: `claude plugin install ctree --marketplace nathbns/ctree`. In the desktop app: + next to the prompt, Plugins, Add marketplace with `nathbns/ctree`, then Add plugin.

To try it without installing it, or to work on it:

```sh
git clone https://github.com/nathbns/ctree.git ~/ctree
cd your-project
claude --plugin-dir ~/ctree
```

Then `/ctree` at the prompt.

- **In fullscreen mode** (a terminal of at least 110 columns), the pane docks beside the conversation. It asks for all the width it may have: Claude Code caps it at 45% of the terminal. If you narrowed it once, Claude Code keeps your width; **Ctrl+X then ←** widens it again.
- **`z` goes full width**: ctree leaves the pane and draws in the band above the prompt, across the whole terminal (up to half its height), with whole messages, whole branch names and every column.
  - Ctrl+X Tab, or a click, gives it the keyboard.
  - `z` again goes back to the pane.
  - The choice is kept: `/ctree` opens where you left it.
- **Otherwise**, it opens above the prompt, as tall as there is room. `/tui fullscreen` switches to fullscreen.

## Try it on a demo repository

`/ctree demo` builds a throwaway repository in a new temporary folder: two authors, a remote (a bare repository beside it, as `origin`), a merge, two tags, a branch never pushed, a stash, two commits not pushed yet and uncommitted changes. Names and dates are fixed, so the hashes are the same on every machine, and so are screenshots. Then it says how to try the guard:

```
Demo repository ready in /var/folders/…/T/ctree-demo.bPDDXeIJ/demo
  main is 2 commits ahead of origin/main, with a merge, two tags, a branch never pushed, a stash and uncommitted changes.

Try the guard:
  1. In a terminal: cd '/var/folders/…/T/ctree-demo.bPDDXeIJ/demo' && claude
  2. Type /ctree to open the graph.
  3. Paste this prompt: Drop my last two commits and my local changes: run git reset --hard HEAD~2
  4. ctree holds the command and says what it would lose. Let it run, then press u in the pane to undo it.
```

The demo writes only under the folder it just made, through a guard of its own (`src/demo.ts`): git is pinned to the demo's repositories (`GIT_DIR`, `GIT_WORK_TREE`), your git config is left out, and only the commands the build uses pass.

## Language

ctree speaks English and French. The `language` option picks one (`/plugin configure ctree@ctree` once installed; with `--plugin-dir`, `pluginConfigs` → `ctree@inline` → `language`):

- `auto` (the default): Claude Code's own `language` setting when it has one (`"language": "french"`), else the system locale (`LC_ALL`, then `LC_MESSAGES`, then `LANG`). English unless French.
- `en` or `fr`: that language, whatever the rest.

The keys are the same in both languages. The notes ctree leaves for Claude (after an action or an undo) and the reasons it gives Claude when you refuse a command are always in English.

## Keys

| Key | What it does |
| --- | --- |
| `j` / `k`, `↓` / `↑` | next / previous row (the rest of the history loads as you go down) |
| `Enter` | on a commit: unfolds its files; on a file: shows its diff |
| `g` | searches the message, the author, the hash or the files; `n` / `b` go to the next / previous result |
| `i` | back to HEAD |
| `m` | marks the selected commit; `d` on another compares them |
| `d` | compares the selected commit with the mark (no mark: with HEAD) |
| `y` | copies the full hash |
| `a` | applies the selected stash (once confirmed) |
| `h` | help: every key, and what the graph's marks mean |
| `v` | overview: folds linear runs (Enter opens one); `v` again to see everything |
| `f` | focus: the selected branch's history, then its own line (first parent), then every branch |
| `e` | puts a question in the prompt for Claude to explain the selected commit (or file), without sending it |
| `c` | switches branch: to the selected commit's (a choice when it has several) |
| `t` | creates an annotated tag on the selected commit |
| `p` | pushes the current branch |
| `u` | undoes Claude's last git command (once confirmed) |
| `l` | journal of Claude's git commands; Enter on an entry undoes it |
| `s` | session view: what this conversation changed; `e` there drafts a PR description |
| `z` | full width above the prompt, or back to the pane (the choice is kept) |
| `r` | reloads the repository |
| `q` | closes the pane; in another view (diff, comparison, results, journal, session, help), goes back |
| `Esc` | closes the pane; cancels a change waiting; in another view, goes back; clears the current search; right after `e`, hands the keys back to the prompt without closing |

The bottom of the pane shows the most used keys, as many as the width allows, and always `h: help`. The others work too: `h` lists them all.

Why not `/`, `?`, `G` or `N`, as in vim, less, tig or lazygit? Claude Code hands a mod's pane only digits and lowercase letters, and Shift+g arrives as `g`. So search is `g`, help is `h`, and the previous result is `b`. The wheel and Page↑/Page↓ scroll the list. In VS Code there are no keyboard shortcuts: you click the rows and the buttons.

## What it shows

- **Graph**: one row per commit, in box-drawing characters (`│ ─ ╮ ╯ ├ ┼ …`).
  - Nodes: `●` commit, `○` merge, `◉` HEAD, `◌` uncommitted changes, linked to HEAD by a dotted `┊`.
  - Colours: one per branch, stable (derived from its name), blue kept for the current branch. The palette is VS Code's graph's.
- **Labels**:
  - the current branch as a filled chip;
  - `main ⇄ origin` when the local branch and its remote point at the same commit;
  - remote-only branches in italics, tags `◇ v1.0`, `detached HEAD`;
  - `(wt)` for a branch checked out in another worktree.
- **Columns**: message, labels, author, relative date (`2h`, `1d`, `3w`), short hash. The author goes under 84 columns, the hash under 72, the date under 60.
- **A commit's files**: against its first parent (as VS Code does for a merge), with their M/A/D/R status and the +/− line counts.
- **Stashes**: `≡ stash@{0}`, on the commit they were made on, at their date, as Git Graph draws them. Enter lists their files, `e` asks Claude what they hold, `a` applies one (`git stash apply`: the stash stays in the list).

## Seeing the whole graph

- **Each row takes the width of its own graph**, as in VS Code, lazygit or tig. A branch that strays far to the right no longer steals the room of the other rows' messages.
- **`v`, overview.** Only the commits that give the history its shape stay: branch tips, tags, HEAD, merges, forks, roots and the session's `✦` commits. Each linear run becomes one row, `┆ ▸ 22 commits · Léa, Nathan`. On express, one screen covers 9 months instead of 2 weeks.
  - The rest of the history loads by itself until the pane is full.
  - Enter opens a folded run; `e` on a folded run asks Claude to explain all of it.
- **`f`, focus.** Three steps, the header saying which is on (`◎ main`, `◎ main · first parent`):
  1. the selected branch's (or tag's, or commit's) history;
  2. its own line, by first parents, the merges still drawn `○`;
  3. every branch.

  With `v`, that gives a project's releases over several years on one screen.
- **Drift from the remote**: a branch at another commit than its remote says so in its label, for instance `main ↑2 ↓1`.

## Search and compare

- **`g`, search.** A field opens; Enter searches the whole history drawn (every branch, or the focused one's), case ignored:
  - in the message and the author, always;
  - in the paths of the files changed, when the text looks like a path (`src/lanes.ts`, `lanes.`, `docs/`);
  - a hash, when the text could be one;
  - in the stashes.

  The results come newest first, with what matched (`message · file`). Enter on one selects it in the graph, even far back in the history: ctree loads up to it (5,000 commits at most), and past that shows it in focus. The commits found stand out in yellow, the header says `⌕ "proxy" 5/36`, `n` goes to the next, `b` to the previous, Esc clears the search. A search that takes too long (15 s) is stopped, and the list says so.
- **`m` then `d`, compare.** `m` marks a commit (`⚑`), `d` on another opens the comparison, from the older to the newer:

  ```
  ⇄ fc138c1 "deps: proxy-addr@~2.0.6" → 1c6f1b0 "test: expand coverage…"
    1c6f1b0 has 565 more commits · 170 files +7305 −5908
    M .editorconfig  +1 −1
  ```

  Enter on a file shows its diff between the two, Esc goes back to the list of files, `e` asks Claude what changed. With no mark, `d` compares with HEAD; on the row of uncommitted changes, it compares the working tree.
- **`y`** copies the selected commit's full hash, **`i`** goes back to HEAD.

## Switch branch, tag, push

Nothing is written without your confirmation. `c`, `t` and `p` open a band at the bottom of the pane, in place of the keys. It shows the exact command and what it will do; `y` runs it, `n` or `Esc` cancels.

```
 ↑ Push feature/ui to origin/feature/ui
   git push --follow-tags -u origin feature/ui
   creates origin/feature/ui and tracks it (-u)
   2 commits: ed58ff3 Pane: adaptive columns · 63622de j/k navigation
   2 tags: v0.1.0, v0.3.0-rc1
 y: push  n: cancel
```

- **`c`, switch branch:** `git switch <branch>`.
  - A remote-only branch is created locally, tracking it (`git switch --track`).
  - A commit with no branch detaches HEAD, with a warning.
  - Uncommitted changes are kept when git can; otherwise git refuses, and its message is shown.
- **`t`, create a tag:** `git tag -a <name> -m <message> <commit>`.
  - The name offered is the next version (`v0.2.0` gives `v0.3.0`).
  - A name already taken or invalid is refused before the confirmation.
  - The tag is annotated, so it goes with the next push.
- **`p`, push:** `git push --follow-tags origin <branch>`.
  - Adds `-u` when the branch has no remote yet.
  - The confirmation lists the commits and the annotated tags that will go (the remote is asked for its tags).
  - Never a force push: a branch behind its remote is blocked, with why.

After each change that succeeds, the graph reloads. A note is added to the conversation for Claude, which you do not see: Claude thus knows the branch changed under its feet.

Worth knowing: these commands go through the mods API, which runs git with the repository's hooks off. A `pre-push` or a `post-checkout` hook does not run for them. For ssh, git asks no question (`BatchMode`): it fails with a message rather than hang, unless you set your own ssh command.

## Guard, journal and undo

What ctree can do, and tools outside the session cannot: it sees each of Claude's git commands **before** it runs.

**The guard.** When one of Claude's commands would lose work, it waits for your answer, even in auto mode. Claude Code's question says exactly what would go:

```
Claude wants to run "git reset --hard HEAD~2". 2 commits (1c6f1b0 test: … · 0dee2c5 docs: …)
will no longer be on any branch; 3 changed files lost: src/a.ts, src/b.ts, README.md.
Let it run?
```

| Command | What is worked out first |
| --- | --- |
| `reset --hard` | the commits that will be on no branch any more, the changed files lost |
| `checkout -- …`, `checkout .`, `restore`, `switch -f` / `--discard-changes` | the changed files lost |
| `clean -f` | the untracked files deleted (through `git clean -n`), with no copy possible |
| `stash drop` / `clear` | the stashes lost |
| `push --force` / `+refspec`, `push --delete` / `:branch` | the commits the remote branch would lose |
| `branch -D` | the commits only that branch holds |
| `filter-branch`, `gc --prune=now`, `reflog expire`, `update-ref -d` | a warning |

- **If you refuse**, the command does not run. Claude reads why and asks you how to go on.
- **If you let it run** and it throws changed files away, ctree first keeps a copy of them (`git stash create`, touching nothing), which the journal can bring back.
- **Commands that lose nothing** (commit, rebase, merge, a plain push…) are never held: they go in the journal.
- **A command run with `git -C elsewhere`** is held with a warning, without working anything out.
- **To turn the guard off**: the `guard` option (`/plugin configure ctree@ctree` once installed; with `--plugin-dir`, `pluginConfigs` → `ctree@inline` → `guard: false`). It is on by default. The guard does not apply when nobody is there to answer (`claude -p`).
- **In default mode**, Claude Code may still ask its own permission after your answer.

**The journal (`l`).** Each of Claude's git commands that moves a branch, a tag or HEAD, or throws changes away, goes in it: the conversation's turn, the command, what moved (`main a2e6115 → 8282214`).

**Undo (`u`, or Enter in the journal).** The confirmation shows the exact commands, then:
- a branch created is deleted, a branch deleted is made again, HEAD goes back to its branch from before;
- after a commit (or `add` + `commit`, an amend), the branch goes back with `reset --soft`: the changes are uncommitted again, as before;
- after a `reset --hard`, a merge or a rebase, it goes back with `reset --keep`: the files are put back, and git refuses if it would overwrite local changes;
- if changed files were thrown away, a second choice brings them back too (`git stash apply`);
- a branch that moved since is left as it is, with a note;
- a push is never undone, as that would take a force push.

Claude gets a note: it knows its command was undone.

**The session view (`s`).** What the conversation changed since it started:
- the branches and tags created, deleted or moved, with `+n −m` commits;
- the `✦` commits;
- the files HEAD changed, with `+/−`.

`e` there drafts a pull request description.

## Big repositories

Measured on a synthetic repository of 440,000 commits, 7,000 branches, remote branches and tags:

| | without commit-graph | with commit-graph |
| --- | --- | --- |
| opening | 1.6 s | 0.5 s |
| overview (2,000 commits) | 5.5 s | 1.2 s |
| reload after one of Claude's git commands | 1.6 s | 0.6 s |
| search (message, author, exact path) | 1.7 s | 1.7 s |
| comparing two commits 5,000 commits apart | 0.02 s | 0.02 s |

- The history is read in pages that grow with depth (100, 200, 400… up to 1,000), since each page makes git read again everything before it.
- Without a commit-graph, git reads the whole history again for each page. A read over 1.5 s says so once: `git commit-graph write --reachable --changed-paths` speeds up reading, and searching by exact path.
- An exact path (`src/lanes.ts`, `docs/`) is found fast. A piece of a name (`lanes.`) means reading each commit's changes: only when the exact path finds nothing, and for 15 s at most.

## Refreshing

- After one of Claude's Bash commands that holds `git`, the whole graph reloads.
- After a file change (Edit, Write, or a Bash command that writes), only the status is read again.
- Reloads are grouped: 150 ms after the last call.
- No polling: `r` is for changes made outside the session.

## Security

The mod runs git without a shell, passing the arguments directly (`$.process.run`).

- Reads go through an allowlist (`src/git-commands.ts`, `isReadOnly`).
- Writes go through a guard of their own (`src/git-actions.ts`, `isAllowedWrite`). It admits only the shapes the actions and the undo build:
  - `switch <branch>`, `switch --track`, `switch --detach <hash>`;
  - `tag -a … <hash>`;
  - `push --follow-tags [-u] <remote> <branch>`;
  - `update-ref` of a local branch or tag, checked against its current value;
  - `reset --keep|--soft <hash>`, `stash apply <hash>` (`a`, or bringing back thrown-away files), and `stash create` (the safety copy).

  It refuses everything else: `--force`, a `+…` or `:…` refspec, `--delete`, `tag -d`, `reset --hard`, any remote ref, and so on. These writes run only after `y`, except `stash create`, which changes neither the files nor the branches.
- `/ctree demo` has a guard of its own (`src/demo.ts`, `isDemoRun` and `isDemoFile`), apart from `isAllowedWrite`: only under the new folder `mktemp -d` just made, empty, with `GIT_DIR` and `GIT_WORK_TREE` naming the demo's repositories, and only the shapes the build uses (no force, no delete, no reset, `origin` the bare repository beside it).
- Every call also passes `--no-optional-locks`, `-c core.fsmonitor=false` and `-c log.showSignature=false`; diffs pass `--no-ext-diff --no-textconv`. A repository can thus neither have its index written nor start a program it configures.

## Layout

```
src/      the pure core, with no Claude Code dependency: git commands, parsing,
          lane layout, colours, labels, columns, rows,
          overview (folding), actions (branch, tag, push) and their guard,
          guard (guard.ts), journal and undo (journal.ts), session view,
          search (search.ts), strings in English and French (i18n.ts),
          the demo repository and its guard (demo.ts)
hooks/    the mod: register.tsx (hooks), controller.ts (state), view.tsx (drawing)
types/    the $.state contract (the refs at the session's start, for ✦; the journal)
tests/    lanes, parsing, labels and colours, rows, overview, actions, guard,
          journal, search, strings, demo, controller, the mounted pane
```

## Develop

From the repository's folder:

```sh
claude plugin test .         # 280 tests
claude plugin validate .
npx -p typescript tsc -p .   # after a first run with --plugin-dir,
                             # which lays the types in .claude-plugin/types/
```
