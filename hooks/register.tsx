// ctree: the repository's commit graph in a pane beside the conversation.
// /ctree opens it; it follows the git commands Claude runs. It reads git, and
// writes only what the person confirms: a branch, a tag, a push, an undo.
// Claude's git commands that would lose work wait for the person's answer,
// and those that change refs go in a journal that can undo them.

import type { EngineInterface, Register } from 'claude-code'

import { isAllowedWrite } from '../src/git-actions'
import { GIT_ENV, isReadOnly, READ_FLAGS } from '../src/git-commands'
import { gitCalls, riskOf } from '../src/guard'
import type { RefState } from '../src/journal'
import type { GitOptions } from '../src/types'
import { createController, type Controller, type Host } from './controller'
import { paneTree } from './view'

const PANE_ID = 'ctree'
const BASELINE = { plugin: 'ctree', key: 'baseline' } as const
const START = { plugin: 'ctree', key: 'start' } as const
const JOURNAL = { plugin: 'ctree', key: 'journal' } as const
const GIT_TIMEOUT_MS = 20_000

/** A docked pane is at most this share of the terminal's width; ctree asks for all of it. */
const DOCK_SHARE = 0.45
/** Above the prompt (no fullscreen), as tall as the layout can spare. */
const INLINE_ROWS = 60

/** The width asked for, from the terminal's width the last /ctree saw. */
const wanted = { columns: 120 }

/** The band above the prompt: as tall as it may be (half the terminal in fullscreen), this at most. */
const BAND_ROWS = 40

/** The band's id, as its render hook last saw it: where the focus ring is moved while ctree is there. */
const band = { id: null as string | null }

const paneArgs = (focus: boolean) => ({
  id: PANE_ID,
  title: 'ctree',
  ...(focus ? { focus: true as const } : {}),
  closeOnEscape: true as const,
  columns: wanted.columns,
  rows: INLINE_ROWS,
})

function hostOf($: EngineInterface, siteId: () => string): Host {
  // Every run, read or write, carries the same flags: no fsmonitor hook, no
  // gpg, no optional lock. Argv only, never a shell.
  const run = async (args: readonly string[], options?: GitOptions) => {
    const result = await $.process.run(['git', ...READ_FLAGS, ...args], {
      env: { ...GIT_ENV, ...options?.env },
      timeoutMs: options?.timeoutMs ?? GIT_TIMEOUT_MS,
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    })

    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  return {
    git: async (args, options) => {
      if (!isReadOnly(args)) {
        throw new Error(`ctree ne lance que des lectures ici : git ${args[0] ?? ''} refusé`)
      }

      return run(args, options)
    },
    write: async (args, options) => {
      if (!isAllowedWrite(args)) {
        throw new Error(`ctree refuse cette écriture : git ${args.join(' ')}`)
      }

      return run(args, options)
    },
    note: async text => {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    },
    hasOwnSsh: async () => Boolean((await $.env.get('GIT_SSH_COMMAND')) || (await $.env.get('GIT_SSH'))),
    cwd: () => $.session.cwd(),
    after: (ms, fn) => $.clock.after(ms, fn),
    invalidate: () => $.ui.invalidate('ui.render'),
    open: async focus => {
      await $.ui.open(paneArgs(focus))
    },
    close: () => $.ui.close({ id: PANE_ID }),
    focus: async key => {
      await $.ui.focus({ requestId: siteId(), key })
    },
    fill: async text => {
      const box = await $.prompt.read()
      const draft = box.text.trim()
      const filled = await $.prompt.fill(
        draft ? { text: `\n\n${text}`, mode: 'append' } : { text, mode: 'replace' },
      )

      return filled.isFilled
    },
    baseline: {
      get: async () => (await $.state.get(BASELINE)).value ?? null,
      set: async tips => {
        await $.state.set(BASELINE, [...tips])
      },
    },
    ask: async (question, options) => {
      try {
        return await $.ui.ask(question, { options: [...options], header: 'ctree' })
      } catch {
        // Dismissed, or nobody to ask: the guard reads it as a refusal.
        return null
      }
    },
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
    },
    turns: () => $.session.turns(),
    now: () => $.clock.now(),
    journal: {
      get: async () => (await $.state.get(JOURNAL)).value ?? null,
      set: async entries => {
        await $.state.set(JOURNAL, [...entries])
      },
    },
    start: {
      get: async () => (await $.state.get(START)).value ?? null,
      set: async start => {
        await $.state.set(START, start)
      },
    },
  }
}

export const register: Register = (on, options) => {
  let ctl: Controller | null = null
  // The guard asks a person: on unless turned off, and only where someone can answer.
  const isGuardOn = options?.guard !== false
  let isGuarded = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ctree',
      description: 'Graphe git du dépôt dans un panneau à côté de la conversation',
      immediate: true,
    })

    ctl = createController(hostOf($, () => (ctl?.placement === 'band' && band.id ? band.id : PANE_ID)))
    isGuarded = isGuardOn && e.isInteractive !== false
    await ctl.loadPlacement().catch(() => undefined)
    // The commits the refs point at now: what the session did is drawn ✦,
    // and the session view counts from there.
    void ctl.recordBaseline().catch(() => undefined)
    void ctl.recordStart().catch(() => undefined)
    void ctl.loadJournal().catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'ctree' }, async ($, e) => {
    if (!ctl) {
      return { text: 'ctree : la session démarre encore, réessaie dans un instant.' }
    }

    wanted.columns = Math.max(24, Math.floor(e.presentation.columns * DOCK_SHARE))

    if (ctl.placement === 'band') {
      ctl.opened()

      return { text: 'ctree s’affiche au-dessus du prompt, sur toute la largeur. Ctrl+X Tab (ou un clic) pour le piloter, z pour le remettre en panneau.' }
    }

    const opened = await $.ui.open(paneArgs(true))

    ctl.opened()

    return opened.isPlaced ? {} : { text: `ctree : ${opened.reason}` }
  })

  // Placed in the band (z), ctree draws above the prompt, the terminal's whole width.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ctl || ctl.placement !== 'band' || !ctl.isOpen || e.props.hasSurvey) {
      return next(e)
    }

    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table

    band.id = e.requestId
    ctl.shown()

    return paneTree({ Box, Text, Button, Code, ...('Input' in table ? { Input: table.Input } : {}) }, ctl, {
      columns: e.props.bodyColumns,
      rows: Math.min(e.props.maxRows, BAND_ROWS),
      isDocked: true,
      now: await $.clock.now(),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table

    if (!ctl) {
      return <Text dimColor>ctree démarre…</Text>
    }

    ctl.shown()

    return paneTree({ Box, Text, Button, Code, ...('Input' in table ? { Input: table.Input } : {}) }, ctl, {
      columns: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      isDocked: e.props.placement === 'dock',
      now: await $.clock.now(),
    })
  })

  // Escape cancels a change waiting in the band and leaves the diff view
  // before it closes anything; right after `e` it only hands the keys back to
  // the prompt where the question waits.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (ctl && e.origin.kind === 'person') {
      const answer = ctl.escape()

      if (answer === 'back') {
        void $.ui.open(paneArgs(true)).catch(() => undefined)

        return { deny: 'retour à la liste' }
      }

      if (answer === 'keep') {
        return { deny: 'le panneau reste ouvert' }
      }
    }

    const result = await next(e)

    if (result.deny === undefined) {
      ctl?.closed()
    }

    return result
  }).catch(($, e, next) => next(e))

  /** Whether a focus or scroll event is about ctree's own site: its pane, or the band while ctree draws there. */
  const isOurs = (e: { component: string; requestId: string }) =>
    e.component === 'Pane' ? e.requestId === PANE_ID : ctl?.placement === 'band' && ctl.isOpen && e.requestId === band.id

  // The ring moving over the rows is the selection moving; past an end it stays.
  on('ui.focus', { component: ['Pane', 'AbovePrompt'] }, ($, e, next) => {
    if (!ctl || e.origin.kind !== 'person' || !isOurs(e)) {
      return next(e)
    }

    return ctl.ringMoved(e.element) === 'stay' ? {} : next(e)
  }).catch(($, e, next) => next(e))

  // The list draws only the rows in view, so it scrolls them itself.
  on('ui.scroll', { component: ['Pane', 'AbovePrompt'] }, ($, e, next) => {
    const isList = ctl?.model.mode.kind === 'list' && ctl.model.snapshot?.kind === 'repo'

    if (!ctl || !isList || e.origin.kind !== 'person' || !isOurs(e)) {
      return next(e)
    }

    ctl.scrolled(e.by)

    return {}
  }).catch(($, e, next) => next(e))

  // Claude's commands. A git command that would lose work waits for the
  // person (the guard); one that changes refs goes in the journal. Then the
  // pane reloads: the whole graph after git, the status after other changes.
  on('tool.call', { tool: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : null
    const isGit = command !== null && /\bgit\b/.test(command)
    let saved: { hash: string; files: number } | undefined
    let before: RefState | null = null

    if (ctl && isGit && command) {
      if (isGuarded) {
        const verdict = await ctl.guard(command)

        if (verdict.deny) {
          return { deny: verdict.deny }
        }

        saved = verdict.saved
      }

      before = await ctl.watch()
    }

    const result = await next(e)

    if (ctl && before && command && result.deny === undefined) {
      const isSubagent = 'agentId' in e && Boolean(e.agentId)

      await ctl.record(command, before, { isSubagent, ...(saved ? { saved } : {}) }).catch(() => undefined)
    }

    if (ctl?.isOpen && result.deny === undefined) {
      if (isGit) {
        ctl.schedule('all')
      } else if (result.isReadOnly !== true) {
        ctl.schedule('status')
      }
    }

    return result
  }).catch(($, e, next) => {
    if (next.called) {
      return next(e)
    }

    // The guard failed before it could ask: a command it would have held does
    // not run unchecked; any other goes on.
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const isRisky = isGuarded && gitCalls(command).some(call => riskOf(call) !== null)

    return isRisky
      ? { deny: 'ctree n’a pas pu vérifier ce que cette commande git perdrait : elle n’a pas été lancée. Demande à la personne avant de réessayer.' }
      : next(e)
  })
}
