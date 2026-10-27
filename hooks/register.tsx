// gittree: the repository's commit graph in a pane beside the conversation.
// /gittree opens it; it follows the git commands Claude runs. It reads git,
// and writes only the three changes the person confirms (branch, tag, push).

import type { EngineInterface, Register } from 'claude-code'

import { isAllowedWrite } from '../src/git-actions'
import { GIT_ENV, isReadOnly, READ_FLAGS } from '../src/git-commands'
import type { GitOptions } from '../src/types'
import { createController, type Controller, type Host } from './controller'
import { paneTree } from './view'

const PANE_ID = 'gittree'
const BASELINE = { plugin: 'gittree', key: 'baseline' } as const
const GIT_TIMEOUT_MS = 20_000

const paneArgs = (focus: boolean) => ({
  id: PANE_ID,
  title: 'Git',
  ...(focus ? { focus: true as const } : {}),
  closeOnEscape: true as const,
  columns: 96,
  rows: 22,
})

function hostOf($: EngineInterface): Host {
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
        throw new Error(`gittree ne lance que des lectures ici : git ${args[0] ?? ''} refusé`)
      }

      return run(args, options)
    },
    write: async (args, options) => {
      if (!isAllowedWrite(args)) {
        throw new Error(`gittree refuse cette écriture : git ${args.join(' ')}`)
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
      await $.ui.focus({ requestId: PANE_ID, key })
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
  }
}

export const register: Register = on => {
  let ctl: Controller | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gittree',
      description: 'Graphe git du dépôt dans un panneau à côté de la conversation',
      immediate: true,
    })

    ctl = createController(hostOf($))
    // The commits the refs point at now: what the session did is drawn ✦.
    void ctl.recordBaseline().catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'gittree' }, async $ => {
    if (!ctl) {
      return { text: 'gittree : la session démarre encore, réessaie dans un instant.' }
    }

    const opened = await $.ui.open(paneArgs(true))

    ctl.opened()

    return opened.isPlaced ? {} : { text: `gittree : ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table

    if (!ctl) {
      return <Text dimColor>gittree démarre…</Text>
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

  // The ring moving over the rows is the selection moving; past an end it stays.
  on('ui.focus', { requestId: PANE_ID }, ($, e, next) => {
    if (!ctl || e.origin.kind !== 'person') {
      return next(e)
    }

    return ctl.ringMoved(e.element) === 'stay' ? {} : next(e)
  }).catch(($, e, next) => next(e))

  // The list draws only the rows in view, so it scrolls them itself.
  on('ui.scroll', { requestId: PANE_ID }, ($, e, next) => {
    const isList = ctl?.model.mode.kind === 'list' && ctl.model.snapshot?.kind === 'repo'

    if (!ctl || !isList || e.origin.kind !== 'person') {
      return next(e)
    }

    ctl.scrolled(e.by)

    return {}
  }).catch(($, e, next) => next(e))

  // After a git command the whole graph reloads; after any other change to
  // the files, only the count of uncommitted changes.
  on('tool.call', { tool: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const result = await next(e)

    if (ctl?.isOpen && result.deny === undefined) {
      const command = 'command' in e && typeof e.command === 'string' ? e.command : null

      if (command !== null && /\bgit\b/.test(command)) {
        ctl.schedule('all')
      } else if (result.isReadOnly !== true) {
        ctl.schedule('status')
      }
    }

    return result
  }).catch(($, e, next) => next(e))
}
