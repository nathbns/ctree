// The pane's tree: the list (header, pinned uncommitted row, the window of
// commits and files, the keys), the diff view, and the states with no graph.

import type { Elements, RenderElement } from 'claude-code'

import { columnsFor, graphLimit, truncate } from '../src/layout'
import { type Item, WIP_KEY } from '../src/list'
import {
  commitLine,
  fileLine,
  graphWidthOf,
  headerLine,
  noteLine,
  type Segment,
  wipLine,
  WIP,
} from '../src/rows'
import { shortHash, statusLetter } from '../src/format'
import type { Controller, DiffMode } from './controller'

export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

export type Frame = {
  /** Body columns of the pane. */
  columns: number
  /** Body rows of the pane. */
  rows: number
  /** Docked beside the transcript, or inline above the prompt. */
  isDocked: boolean
  now: number
}

/** Rows the list keeps for itself: the header and the keys. */
const CHROME_ROWS = 2

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
  const size = Math.max(1, frame.rows - CHROME_ROWS - (hasWip ? 1 : 0))

  ctl.setWindowSize(size)

  const items = ctl.items()
  const top = ctl.model.top
  const shown = items.slice(top, top + size)
  const selected = ctl.model.selected
  const graphRows = [
    ...(hasWip ? [view.rowOf.get(WIP) ?? 0] : []),
    ...shown.map(item => view.rowOf.get(item.kind === 'commit' ? item.commit.hash : item.under) ?? 0),
  ]
  const options = {
    width,
    graphWidth: graphWidthOf(view, graphRows, graphLimit(width)),
    columns: columnsFor(width),
    now: frame.now,
  }
  const header = ctl.model.notice
    ? [{ text: truncate(ctl.model.notice, width), color: 'claude' } as Segment]
    : headerLine(snapshot, width)
  const emptyNote: Segment[] =
    items.length === 0 ? [{ text: '   Aucun commit pour l’instant.', dim: true }] : []

  const rowOf = (item: Item) => {
    const isSelected = item.key === selected
    const line = { ...options, isSelected }

    if (item.kind === 'commit') return row(ui, item.key, commitLine(view, item.commit, line), isSelected, () => ctl.press(item))
    if (item.kind === 'file') return row(ui, item.key, fileLine(view, item.under, item.change, line), isSelected, () => ctl.press(item))

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
          selected === WIP_KEY,
          () => ctl.press('wip'),
        )}
      <Box flexDirection="column" flexGrow={1}>
        {emptyNote.length > 0 && <Text>{segments(ui, emptyNote)}</Text>}
        {shown.map(rowOf)}
      </Box>
      {keys(ui, ctl, width, 'list')}
    </Box>
  )
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
function row(ui: Ui, key: string, line: Segment[], isSelected: boolean, onPress: () => void): RenderElement {
  const { Button } = ui

  return (
    <Button key={key} plain {...(isSelected ? { autoFocus: true as const } : {})} onPress={onPress}>
      {segments(ui, line)}
    </Button>
  )
}

/** The keys, drawn as the Buttons their hotkeys press, wide or narrow. */
function keys(ui: Ui, ctl: Controller, width: number, where: 'list' | 'diff' | 'message'): RenderElement {
  const { Box, Button, Text } = ui
  const isWide = width >= 66
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

  return (
    <Box flexDirection="row" columnGap={isWide ? 2 : 1}>
      {key('j', '↓', () => ctl.move(1))}
      {key('k', '↑', () => ctl.move(-1))}
      {isWide && <Text dimColor>⏎ déplier</Text>}
      {key('e', isWide ? 'expliquer' : 'expl.', () => void ctl.explain())}
      {key('r', isWide ? 'rafraîchir' : 'maj', () => void ctl.refresh())}
      {key('q', isWide ? 'fermer' : '✕', () => void ctl.close())}
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
