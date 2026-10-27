// The pane's tree: the list (header, pinned uncommitted row, the window of
// commits and files, the keys or the band of a change waiting for its
// confirmation), the diff view, and the states with no graph.

import type { Elements, RenderElement } from 'claude-code'

import { displayCommand } from '../src/git-actions'
import { columnsFor, graphLimit, textWidth, truncate } from '../src/layout'
import { type Item, WIP_KEY } from '../src/list'
import {
  commitLine,
  fileLine,
  foldLine,
  graphWidthOf,
  headerLine,
  noteLine,
  type Segment,
  wipLine,
  WIP,
} from '../src/rows'
import { shortHash, statusLetter } from '../src/format'
import type { Band, Controller, DiffMode } from './controller'

/** The elements drawn with; `Input` is absent where the surface has none (mobile). */
export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'> &
  Partial<Pick<Elements['terminal'], 'Input'>>

export type Frame = {
  /** Body columns of the pane. */
  columns: number
  /** Body rows of the pane. */
  rows: number
  /** Docked beside the transcript, or inline above the prompt. */
  isDocked: boolean
  now: number
}

/** The list's keys, long while they fit on one row, else short. */
const LONG_KEYS: readonly (readonly [string, string])[] = [
  ['j', '↓'], ['k', '↑'], ['⏎', 'ouvrir'], ['v', 'vue'], ['f', 'focus'], ['e', 'expliquer'],
  ['c', 'branche'], ['t', 'tag'], ['p', 'push'], ['r', 'maj'], ['q', 'fermer'],
]
const SHORT_KEYS: readonly (readonly [string, string])[] = [
  ['j', '↓'], ['k', '↑'], ['⏎', ''], ['v', 'vue'], ['f', 'focus'], ['e', 'expl.'],
  ['c', 'br.'], ['t', 'tag'], ['p', 'push'], ['r', 'maj'], ['q', '✕'],
]

const keysWidth = (keys: readonly (readonly [string, string])[], gap: number) =>
  keys.reduce((sum, [key, label]) => sum + textWidth(key === '⏎' ? `⏎ ${label}`.trim() : `${key}: ${label}`), 0) +
  gap * (keys.length - 1)

/** Rows the keys take: one, or two once even the short ones wrap. */
const keyRows = (width: number) => (keysWidth(SHORT_KEYS, 1) <= width ? 1 : 2)

/** Rows a band takes, so the window of rows above it keeps the pane's height. */
function bandRows(band: Band): number {
  switch (band.kind) {
    case 'preparing':
    case 'running':
      return 2
    case 'confirm':
      return 3 + band.action.details.length
    case 'choose':
      return 2 + Math.min(9, band.actions.length)
    case 'tag-form':
      return 4
    case 'info':
      return 2 + band.lines.length
  }
}

export function paneTree(ui: Ui, ctl: Controller, frame: Frame): RenderElement {
  const { Box, Text } = ui
  const width = Math.max(20, frame.columns - 1)
  const snapshot = ctl.model.snapshot

  if (ctl.model.mode.kind === 'diff') {
    return diffTree(ui, ctl, ctl.model.mode, width)
  }

  if (snapshot === null) {
    return message(ui, frame, [{ text: 'Lecture du dépôt…', dim: true }], [])
  }

  if (snapshot.kind === 'no-repo') {
    return message(ui, frame, [{ text: snapshot.reason === 'bare' ? 'Dépôt nu : pas d’arbre de travail à montrer.' : 'Pas de dépôt git ici.', bold: true }], [
      { text: truncate(snapshot.cwd, width), dim: true },
      { text: 'Le panneau se met à jour dès qu’un dépôt existe (git init, git clone).', dim: true },
    ], ctl, width)
  }

  if (snapshot.kind === 'error') {
    return message(ui, frame, [{ text: 'git a échoué', color: 'error', bold: true }], [
      { text: truncate(snapshot.message, width) },
      { text: 'r pour réessayer.', dim: true },
    ], ctl, width)
  }

  const view = ctl.model.view

  if (!view) {
    return message(ui, frame, [{ text: 'Lecture du dépôt…', dim: true }], [])
  }

  const hasWip = snapshot.status.length > 0
  const band = ctl.model.action
  const chrome = 1 + (band ? bandRows(band) : keyRows(width))
  const size = Math.max(1, frame.rows - chrome - (hasWip ? 1 : 0))

  ctl.setWindowSize(size)

  const items = ctl.items()
  const top = ctl.model.top
  const shown = items.slice(top, top + size)
  const selected = ctl.model.selected
  const graphRows = [
    ...(hasWip ? [view.rowOf.get(WIP) ?? 0] : []),
    ...shown.map(item => view.rowOf.get(item.kind === 'commit' ? item.commit.hash : item.kind === 'fold' ? item.fold.id : item.under) ?? 0),
  ]
  const options = {
    width,
    graphWidth: graphWidthOf(view, graphRows, graphLimit(width)),
    columns: columnsFor(width),
    now: frame.now,
  }
  const header = ctl.model.notice
    ? [{ text: truncate(ctl.model.notice, width), color: 'claude' } as Segment]
    : headerLine(snapshot, width, ctl.model.isOverview)
  const emptyNote: Segment[] =
    items.length === 0 ? [{ text: '   Aucun commit pour l’instant.', dim: true }] : []

  // The ring starts on the selected row, unless a band holds it.
  const rowOf = (item: Item) => {
    const isSelected = item.key === selected
    const line = { ...options, isSelected }
    const isStart = isSelected && !band

    if (item.kind === 'commit') return row(ui, item.key, commitLine(view, item.commit, line), isStart, () => ctl.press(item))
    if (item.kind === 'file') return row(ui, item.key, fileLine(view, item.under, item.change, line), isStart, () => ctl.press(item))
    if (item.kind === 'fold') return row(ui, item.key, foldLine(view, item.fold, line), isStart, () => ctl.press(item))

    return <Text>{segments(ui, noteLine(view, item.under, item.text, line))}</Text>
  }

  return (
    <Box flexDirection="column" {...(frame.isDocked ? { height: frame.rows } : {})}>
      <Text wrap="truncate-end">{segments(ui, header)}</Text>
      {hasWip &&
        row(
          ui,
          WIP_KEY,
          wipLine(view, snapshot.status.length, { ...options, isSelected: selected === WIP_KEY }),
          selected === WIP_KEY && !band,
          () => ctl.press('wip'),
        )}
      <Box flexDirection="column" flexGrow={1}>
        {emptyNote.length > 0 && <Text>{segments(ui, emptyNote)}</Text>}
        {shown.map(rowOf)}
      </Box>
      {band ? bandTree(ui, ctl, band, width) : keys(ui, ctl, width, 'list')}
    </Box>
  )
}

/** The band of a change: what it runs, then y or n. Its cancel key holds the ring. */
function bandTree(ui: Ui, ctl: Controller, band: Band, width: number): RenderElement {
  const { Box, Text, Button, Input } = ui
  const line = (text: string) => truncate(text, width)
  const act = (hotkey: string, label: string, onPress: () => void, isStart = false) => (
    <Button key={`act-${hotkey}`} plain hotkey={hotkey} label={label} {...(isStart ? { autoFocus: true as const } : {})} onPress={onPress} />
  )
  const cancel = (label = 'annuler') => act('n', label, () => ctl.cancelAction(), true)

  switch (band.kind) {
    case 'preparing':
      return (
        <Box flexDirection="column">
          <Text bold>{line(band.title)}</Text>
          <Box flexDirection="row" columnGap={2}>{cancel()}</Box>
        </Box>
      )
    case 'running':
      return (
        <Box flexDirection="column">
          <Text bold>{line(band.action.title)}</Text>
          <Text dimColor>{line(`  ${displayCommand(band.action.args)} en cours…`)}</Text>
        </Box>
      )
    case 'confirm':
      return (
        <Box flexDirection="column">
          <Text bold>{line(band.action.title)}</Text>
          <Text color="claude">{line(`  ${displayCommand(band.action.args)}`)}</Text>
          {band.action.details.map(detail => (
            <Text dimColor>{line(`  ${detail}`)}</Text>
          ))}
          <Box flexDirection="row" columnGap={2}>
            {act('y', band.action.confirm, () => void ctl.confirm())}
            {cancel()}
          </Box>
        </Box>
      )
    case 'choose':
      return (
        <Box flexDirection="column">
          <Text bold>{line(band.title)}</Text>
          {band.actions.slice(0, 9).map((action, i) => act(String(i + 1), line(displayCommand(action.args)), () => void ctl.confirm(i)))}
          <Box flexDirection="row" columnGap={2}>{cancel()}</Box>
        </Box>
      )
    case 'tag-form': {
      const title = `◇ Nouveau tag sur ${shortHash(band.commit.hash)} « ${band.commit.subject} »`

      if (!Input) {
        return (
          <Box flexDirection="column">
            <Text bold>{line(title)}</Text>
            <Text dimColor>{line('  Créer un tag demande un champ de texte, absent ici.')}</Text>
            <Text dimColor> </Text>
            <Box flexDirection="row" columnGap={2}>{cancel('fermer')}</Box>
          </Box>
        )
      }

      const submit = (field: 'name' | 'message') => (value: string) => {
        ctl.setTagField(field, value)
        ctl.submitTag()
      }

      return (
        <Box flexDirection="column">
          <Text bold>{line(title)}</Text>
          <Input
            key="tag-name"
            label="Nom"
            value={band.name}
            placeholder="v1.0.0"
            submitLabel="valider"
            autoFocus
            onInput={value => ctl.setTagField('name', value)}
            onSubmit={submit('name')}
          />
          <Input
            key="tag-message"
            label="Message"
            value={band.message}
            placeholder={band.name || 'message du tag'}
            submitLabel="valider"
            onInput={value => ctl.setTagField('message', value)}
            onSubmit={submit('message')}
          />
          {band.error ? (
            <Text color="error">{line(`  ${band.error}`)}</Text>
          ) : (
            <Text dimColor>{line('  ⏎ valider · Tab champ suivant · Échap annuler')}</Text>
          )}
        </Box>
      )
    }
    case 'info':
      return (
        <Box flexDirection="column">
          <Text bold {...(band.isError ? { color: 'error' } : {})}>{line(band.title)}</Text>
          {band.lines.map(text => (
            <Text dimColor={!band.isError}>{line(`  ${text}`)}</Text>
          ))}
          <Box flexDirection="row" columnGap={2}>{cancel('fermer')}</Box>
        </Box>
      )
  }
}

function diffTree(ui: Ui, ctl: Controller, mode: DiffMode, width: number): RenderElement {
  const { Box, Text, Code } = ui
  const where = mode.commit ? `${shortHash(mode.commit.hash)} ${mode.commit.subject}` : 'non commité'
  const name = mode.change.oldPath ? `${mode.change.oldPath} → ${mode.change.path}` : mode.change.path
  const title = truncate(`${statusLetter(mode.change.status)} ${name} · ${where}`, width)

  const body = (() => {
    switch (mode.diff.kind) {
      case 'loading':
        return <Text dimColor>Lecture du diff…</Text>
      case 'error':
        return <Text color="error">{`git a échoué : ${mode.diff.message}`}</Text>
      case 'binary':
        return <Text dimColor>Fichier binaire : pas de diff texte.</Text>
      case 'empty':
        return <Text dimColor>Aucune différence de contenu (mode ou renommage seul).</Text>
      case 'hunks':
        return (
          <Box flexDirection="column">
            <Code format="diff" source={mode.diff.source} path={mode.change.path} />
            {mode.diff.isCut && <Text dimColor>… diff tronqué : la suite avec git show.</Text>}
          </Box>
        )
    }
  })()

  return (
    <Box flexDirection="column">
      {keys(ui, ctl, width, 'diff')}
      <Text bold wrap="truncate-end">{title}</Text>
      {body}
    </Box>
  )
}

function message(
  ui: Ui,
  frame: Frame,
  title: Segment[],
  lines: Segment[],
  ctl?: Controller,
  width = 40,
): RenderElement {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column" {...(frame.isDocked ? { height: frame.rows } : {})}>
      <Text>{segments(ui, title)}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {lines.map(line => (
          <Text>{segments(ui, [line])}</Text>
        ))}
      </Box>
      {ctl && keys(ui, ctl, width, 'message')}
    </Box>
  )
}

/** One selectable row: a plain Button whose label is the row's runs. */
function row(ui: Ui, key: string, line: Segment[], isStart: boolean, onPress: () => void): RenderElement {
  const { Button } = ui

  return (
    <Button key={key} plain {...(isStart ? { autoFocus: true as const } : {})} onPress={onPress}>
      {segments(ui, line)}
    </Button>
  )
}

/** The keys, drawn as the Buttons their hotkeys press, wide or narrow. */
function keys(ui: Ui, ctl: Controller, width: number, where: 'list' | 'diff' | 'message'): RenderElement {
  const { Box, Button, Text } = ui
  const key = (hotkey: string, label: string, onPress: () => void) => (
    <Button key={`key-${hotkey}`} plain hotkey={hotkey} label={label} dimColor onPress={onPress} />
  )

  if (where === 'diff') {
    return (
      <Box flexDirection="row" columnGap={2}>
        {key('q', 'retour', () => ctl.back())}
        {key('e', 'expliquer', () => void ctl.explain())}
        <Text dimColor>↑↓ défiler</Text>
      </Box>
    )
  }

  if (where === 'message') {
    return (
      <Box flexDirection="row" columnGap={2}>
        {key('r', 'rafraîchir', () => void ctl.refresh())}
        {key('q', 'fermer', () => void ctl.close())}
      </Box>
    )
  }

  // Long labels two apart, else one apart, else the short ones.
  const gap = keysWidth(LONG_KEYS, 2) <= width ? 2 : 1
  const labels = new Map(keysWidth(LONG_KEYS, gap) <= width ? LONG_KEYS : SHORT_KEYS)
  const label = (hotkey: string) => labels.get(hotkey) ?? hotkey

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={gap}>
      {key('j', label('j'), () => ctl.move(1))}
      {key('k', label('k'), () => ctl.move(-1))}
      <Text dimColor>{`⏎ ${label('⏎')}`.trim()}</Text>
      {key('v', label('v'), () => ctl.toggleOverview())}
      {key('f', label('f'), () => ctl.cycleFocus())}
      {key('e', label('e'), () => void ctl.explain())}
      {key('c', label('c'), () => ctl.beginSwitch())}
      {key('t', label('t'), () => ctl.beginTag())}
      {key('p', label('p'), () => void ctl.beginPush())}
      {key('r', label('r'), () => void ctl.refresh())}
      {key('q', label('q'), () => void ctl.close())}
    </Box>
  )
}

/** Runs of text as `Text` elements, with only the props each run sets. */
function segments(ui: Ui, line: readonly Segment[]): RenderElement[] {
  const { Text } = ui

  return line.map(segment => (
    <Text
      {...(segment.color ? { color: segment.color } : {})}
      {...(segment.bold ? { bold: true } : {})}
      {...(segment.italic ? { italic: true } : {})}
      {...(segment.dim ? { dimColor: true } : {})}
      {...(segment.inverse ? { inverse: true } : {})}
    >
      {segment.text}
    </Text>
  ))
}
