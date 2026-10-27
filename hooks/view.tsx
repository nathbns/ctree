// The pane's tree: the list (header, pinned uncommitted row, the window of
// commits and files, the keys or the band of a change waiting for its
// confirmation, or of Claude's command the guard holds), the diff view, the
// comparison of two commits, the search's results, the journal of Claude's
// git commands, the session view, the help, and the states with no graph.

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
import { counts, relativeDate, shortAuthor, shortHash, statusLetter } from '../src/format'
import { describeMoves } from '../src/journal'
import { matchWords } from '../src/search'
import type { Band, CompareMode, Controller, DiffMode, SearchMode, SessionMode } from './controller'

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

/** A key of the list: its hotkey (⏎ is drawn, not pressed), its label wide and narrow. */
type Key = { hotkey: string; long: string; short: string; onPress?: () => void }

/** The list's keys, most used first: those that fit are drawn, the rest work hidden, all listed by h. */
function listKeys(ctl: Controller): Key[] {
  const isStash = ctl.isStashSelected()

  return [
    { hotkey: 'j', long: '↓', short: '↓', onPress: () => ctl.move(1) },
    { hotkey: 'k', long: '↑', short: '↑', onPress: () => ctl.move(-1) },
    { hotkey: '⏎', long: 'ouvrir', short: '' },
    ...(ctl.model.search ? [{ hotkey: 'n', long: 'suivant', short: 'suiv.', onPress: () => void ctl.nextHit() }] : []),
    ...(isStash ? [{ hotkey: 'a', long: 'appliquer', short: 'appl.', onPress: () => ctl.beginApplyStash() }] : []),
    { hotkey: 'g', long: 'chercher', short: 'cherch.', onPress: () => ctl.beginSearch() },
    { hotkey: 'e', long: 'expliquer', short: 'expl.', onPress: () => void ctl.explain() },
    { hotkey: 'd', long: 'comparer', short: 'comp.', onPress: () => void ctl.beginCompare() },
    { hotkey: 'm', long: 'marquer', short: 'marq.', onPress: () => ctl.toggleMark() },
    { hotkey: 'c', long: 'branche', short: 'br.', onPress: () => ctl.beginSwitch() },
    { hotkey: 'p', long: 'push', short: 'push', onPress: () => void ctl.beginPush() },
    { hotkey: 'u', long: 'annuler', short: '⟲', onPress: () => void ctl.beginUndo() },
    { hotkey: 'v', long: 'vue', short: 'vue', onPress: () => ctl.toggleOverview() },
    { hotkey: 'f', long: 'focus', short: 'focus', onPress: () => ctl.cycleFocus() },
    { hotkey: 'i', long: 'HEAD', short: 'HEAD', onPress: () => void ctl.jumpHead() },
    { hotkey: 'y', long: 'copier', short: 'copie', onPress: () => void ctl.copyHash() },
    { hotkey: 'l', long: 'journal', short: 'journal', onPress: () => ctl.openJournal() },
    { hotkey: 's', long: 'session', short: 'session', onPress: () => void ctl.openSession() },
    { hotkey: 't', long: 'tag', short: 'tag', onPress: () => ctl.beginTag() },
    ...(isStash ? [] : [{ hotkey: 'a', long: 'appliquer', short: 'appl.', onPress: () => ctl.beginApplyStash() }]),
    ...(ctl.model.search ? [] : [{ hotkey: 'n', long: 'suivant', short: 'suiv.', onPress: () => void ctl.nextHit() }]),
    { hotkey: 'z', long: ctl.placement === 'band' ? 'panneau' : 'agrandir', short: ctl.placement === 'band' ? 'panneau' : 'large', onPress: () => void ctl.zoom() },
    { hotkey: 'r', long: 'maj', short: 'maj', onPress: () => void ctl.refresh() },
    { hotkey: 'q', long: 'fermer', short: '✕', onPress: () => void ctl.close() },
  ]
}

/** `h: aide`, drawn last whatever the width: it lists every key. */
const HELP_KEY = 'h: aide'

const keyText = (key: Key, isLong: boolean) => {
  const label = isLong ? key.long : key.short

  return key.hotkey === '⏎' ? `⏎ ${label}`.trim() : `${key.hotkey}: ${label}`
}

/** Rows the list's keys take: one, two in a narrow pane. */
const keyRows = (width: number) => (width >= 80 ? 1 : 2)

/** Rows `texts` take, wrapped as a row Box wraps them. */
function rowsOf(texts: readonly string[], width: number, gap: number): number {
  let rows = 1
  let used = 0

  for (const text of texts) {
    const size = textWidth(text)

    if (used > 0 && used + gap + size > width) {
      rows += 1
      used = size
    } else {
      used += (used > 0 ? gap : 0) + size
    }
  }

  return rows
}

/**
 * The keys drawn: the most used, in order, as many as fit in `rows` rows of
 * `width` with HELP_KEY after them. The others are drawn hidden: they work.
 */
export function fitKeys(keys: readonly Key[], width: number, rows: number): { shown: Key[]; hidden: Key[]; isLong: boolean; gap: number } {
  const isLong = width >= 120
  const gap = isLong ? 2 : 1
  let count = 0

  while (count < keys.length && rowsOf([...keys.slice(0, count + 1).map(key => keyText(key, isLong)), HELP_KEY], width, gap) <= rows) {
    count += 1
  }

  const shown = keys.slice(0, count)

  return { shown, hidden: keys.slice(count).filter(key => key.hotkey !== '⏎'), isLong, gap }
}

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
    case 'search-form':
      return 3
    case 'info':
      return 2 + band.lines.length
    case 'guard':
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

  if (ctl.model.mode.kind === 'journal') {
    return journalTree(ui, ctl, width, frame.now)
  }

  if (ctl.model.mode.kind === 'session') {
    return sessionTree(ui, ctl, ctl.model.mode, width, frame.now)
  }

  if (ctl.model.mode.kind === 'compare') {
    return compareTree(ui, ctl, ctl.model.mode, width)
  }

  if (ctl.model.mode.kind === 'search') {
    return searchTree(ui, ctl, ctl.model.mode, width, frame.now)
  }

  if (ctl.model.mode.kind === 'help') {
    return helpTree(ui, ctl, width)
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
  const search = ctl.model.search
  const header = ctl.model.notice
    ? [{ text: truncate(ctl.model.notice, width), color: 'claude' } as Segment]
    : headerLine(snapshot, width, {
        isOverview: ctl.model.isOverview,
        mark: ctl.model.mark,
        search: search ? { query: search.query, index: search.index, count: search.hashes.length } : null,
      })
  const matches = new Set(search?.hashes ?? [])
  const emptyNote: Segment[] =
    items.length === 0 ? [{ text: '   Aucun commit pour l’instant.', dim: true }] : []

  // The ring starts on the selected row, unless a band holds it.
  const rowOf = (item: Item) => {
    const isSelected = item.key === selected
    const line = { ...options, isSelected }
    const isStart = isSelected && !band

    if (item.kind === 'commit') {
      const marks = { isMatch: matches.has(item.commit.hash), isMarked: ctl.model.mark === item.commit.hash }

      return row(ui, item.key, commitLine(view, item.commit, { ...line, ...marks }), isStart, () => ctl.press(item))
    }

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
    case 'search-form':
      if (!Input) {
        return (
          <Box flexDirection="column">
            <Text bold>⌕ Chercher</Text>
            <Text dimColor>{line('  Chercher demande un champ de texte, absent ici.')}</Text>
            <Box flexDirection="row" columnGap={2}>{cancel('fermer')}</Box>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Input
            key="search-query"
            label="⌕ Chercher"
            value={band.query}
            placeholder="message, auteur, hash ou fichier"
            submitLabel="chercher"
            autoFocus
            onInput={value => ctl.setSearchQuery(value)}
            onSubmit={value => void ctl.submitSearch(value)}
          />
          <Text dimColor>{line('  ⏎ chercher · Échap annuler · dans toutes les branches, majuscules ignorées')}</Text>
        </Box>
      )
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
    case 'guard':
      return (
        <Box flexDirection="column">
          <Text bold color="warning">{line(`⚠ Claude veut lancer « ${band.command} »`)}</Text>
          {band.lines.map(text => (
            <Text>{line(`  ${text}`)}</Text>
          ))}
          <Text dimColor>{line('  Réponds dans la question de Claude Code.')}</Text>
        </Box>
      )
  }
}

/** Claude's git commands this session, newest first: Enter on one undoes it. */
function journalTree(ui: Ui, ctl: Controller, width: number, now: number): RenderElement {
  const { Box, Button, Text } = ui
  const journal = ctl.model.journal
  const band = ctl.model.action
  const line = (text: string) => truncate(text, width)

  return (
    <Box flexDirection="column">
      <Text bold>{line(`⟲ Journal des commandes git de Claude · ${journal.length}`)}</Text>
      {journal.length === 0 && <Text dimColor>{line('  Claude n’a encore rien changé avec git dans cette session.')}</Text>}
      {journal.map((entry, i) => {
        const when = relativeDate(Math.floor(entry.at / 1000), now)
        const who = entry.isSubagent ? ' · sous-agent' : ''
        const label = line(`tour ${entry.turn} · ${entry.command}${who}${entry.isUndone ? ' · annulé' : ''} · ${when}`)

        return (
          <Box flexDirection="column">
            <Button
              key={`journal-${entry.id}`}
              plain
              {...(i === 0 && !band ? { autoFocus: true as const } : {})}
              {...(entry.isUndone ? { dimColor: true } : {})}
              onPress={() => void ctl.beginUndo(entry.id)}
            >
              {label}
            </Button>
            <Text dimColor>{line(`    ${describeMoves(entry).join(' · ') || 'rien de changé'}`)}</Text>
          </Box>
        )
      })}
      {band ? bandTree(ui, ctl, band, width) : keys(ui, ctl, width, 'journal')}
    </Box>
  )
}

/** What this conversation changed: refs, commits, files. Long, it scrolls. */
function sessionTree(ui: Ui, ctl: Controller, mode: SessionMode, width: number, now: number): RenderElement {
  const { Box, Text } = ui
  const line = (text: string) => truncate(text, width)
  const data = mode.data

  const body = (() => {
    if (mode.error) return [<Text color="error">{line(`  ${mode.error}`)}</Text>]
    if (!data) return [<Text dimColor>{line('  Lecture de la session…')}</Text>]

    const changes = data.refs.map(ref => {
      const what =
        ref.change === 'new'
          ? `nouvelle (${shortHash(ref.after ?? '')})`
          : ref.change === 'deleted'
            ? `supprimée (était ${shortHash(ref.before ?? '')})`
            : `${shortHash(ref.before ?? '')} → ${shortHash(ref.after ?? '')}${ref.gained !== undefined ? `  +${ref.gained} −${ref.lost ?? 0}` : ''}`

      return <Text>{line(`    ${ref.name.padEnd(22)} ${what}`)}</Text>
    })
    const added = data.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
    const deleted = data.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)

    return [
      <Text bold>{line(`  Branches et tags · ${data.refs.length}`)}</Text>,
      ...(changes.length ? changes : [<Text dimColor>{line('    rien n’a bougé')}</Text>]),
      <Text bold>{line(`  Commits ✦ · ${data.commits.length}`)}</Text>,
      ...(data.commits.length
        ? data.commits.slice(0, 20).map(commit => <Text>{line(`    ${shortHash(commit.hash)} ${commit.subject}`)}</Text>)
        : [<Text dimColor>{line('    aucun')}</Text>]),
      <Text bold>{line(`  Fichiers changés par HEAD · ${data.files.length}${data.files.length ? ` · +${added} −${deleted}` : ''}`)}</Text>,
      ...(data.files.length
        ? data.files.slice(0, 30).map(file => <Text>{line(`    ${statusLetter(file.status)} ${file.path}  ${counts(file.added, file.deleted)}`)}</Text>)
        : [<Text dimColor>{line('    aucun')}</Text>]),
    ]
  })()

  return (
    <Box flexDirection="column">
      {keys(ui, ctl, width, 'session')}
      <Text bold color="claude">{line(`✦ Cette session${data ? ` · depuis ${relativeDate(Math.floor(data.since / 1000), now)}` : ''}`)}</Text>
      {body}
    </Box>
  )
}

/** Two commits compared: how far apart, then the files that differ, Enter on one for its diff. */
function compareTree(ui: Ui, ctl: Controller, mode: CompareMode, width: number): RenderElement {
  const { Box, Button, Text } = ui
  const line = (text: string) => truncate(text, width)
  const name = (commit: CompareMode['from']) => `${shortHash(commit.hash)} « ${commit.subject} »`
  const to = mode.to ? name(mode.to) : 'les modifications non commitées'
  const files = mode.files.state === 'ready' ? mode.files.files : []
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)
  const apart = mode.counts && mode.to
    ? [
        `${shortHash(mode.to.hash)} a ${plural(mode.counts.ahead, 'commit')} de plus`,
        ...(mode.counts.behind > 0 ? [`${shortHash(mode.from.hash)} en a ${mode.counts.behind} que l’autre n’a pas`] : []),
      ]
    : []
  const summary = [...apart, ...(mode.files.state === 'ready' ? [`${plural(files.length, 'fichier')}${files.length ? ` +${added} −${deleted}` : ''}`] : [])]

  const body = (() => {
    if (mode.files.state === 'loading') return [<Text dimColor>{line('  Lecture des différences…')}</Text>]
    if (mode.files.state === 'error') return [<Text color="error">{line(`  git a échoué : ${mode.files.message}`)}</Text>]
    if (files.length === 0) return [<Text dimColor>{line('  Aucune différence de contenu.')}</Text>]

    return files.slice(0, 300).map((file, i) => {
      const letter = statusLetter(file.status)
      const amount = counts(file.added, file.deleted)
      const path = truncate(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path, Math.max(8, width - 6 - textWidth(amount)))

      return (
        <Button key={`cmp-${i}`} plain {...(i === mode.ring ? { autoFocus: true as const } : {})} onPress={() => ctl.openCompareFile(i)}>
          <Text bold>{`  ${letter} `}</Text>
          <Text>{path}</Text>
          <Text dimColor>{`  ${amount}`}</Text>
        </Button>
      )
    })
  })()

  return (
    <Box flexDirection="column">
      {keys(ui, ctl, width, 'compare')}
      <Text bold color="suggestion">{line(`⇄ ${name(mode.from)} → ${to}`)}</Text>
      {summary.length > 0 && <Text dimColor>{line(`  ${summary.join(' · ')}`)}</Text>}
      {body}
      {files.length > 300 && <Text dimColor>{line(`  … et ${files.length - 300} autres : git diff --stat`)}</Text>}
    </Box>
  )
}

/** What a search found, newest first: Enter on one shows it in the graph. */
function searchTree(ui: Ui, ctl: Controller, mode: SearchMode, width: number, now: number): RenderElement {
  const { Box, Button, Text } = ui
  const line = (text: string) => truncate(text, width)
  const result = mode.result
  const missed = result?.missed.length ? ` · ${matchWords(result.missed)} : trop long, non cherché` : ''
  const title = result
    ? `⌕ « ${mode.query} » · ${result.hits.length === 0 ? 'rien trouvé' : plural(result.hits.length, 'commit')}${result.isCut ? ' (les plus récents)' : ''}${missed}`
    : `⌕ « ${mode.query} » · recherche…`

  const body = (() => {
    if (mode.error) return [<Text color="error">{line(`  ${mode.error}`)}</Text>]
    if (!result) return [<Text dimColor>{line('  Lecture de l’historique…')}</Text>]
    if (result.hits.length === 0) return [<Text dimColor>{line('  Aucun commit ne correspond, dans le message, l’auteur, le hash ou les fichiers.')}</Text>]

    return result.hits.map((hit, i) => {
      const side = `${shortAuthor(hit.commit.author)} · ${relativeDate(hit.commit.time, now)} · ${matchWords(hit.by)}`
      const room = Math.max(8, width - 12 - textWidth(side))
      const subject = truncate(hit.commit.stash ? `${hit.commit.stash} ${hit.commit.subject}` : hit.commit.subject, room)

      return (
        <Button key={`hit-${hit.commit.hash}`} plain {...(i === 0 ? { autoFocus: true as const } : {})} onPress={() => void ctl.openHit(hit.commit.hash)}>
          <Text color="warning">{`  ${shortHash(hit.commit.hash)} `}</Text>
          <Text>{subject}</Text>
          <Text dimColor>{`${' '.repeat(Math.max(1, room - textWidth(subject) + 1))}${side}`}</Text>
        </Button>
      )
    })
  })()

  return (
    <Box flexDirection="column">
      {keys(ui, ctl, width, 'search')}
      <Text bold color="warning">{line(title)}</Text>
      {body}
    </Box>
  )
}

/** Every key, by what it is for, and what the graph's marks mean. */
const HELP: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['Se déplacer', [
    ['j k ↓ ↑', 'commit suivant, précédent (la molette fait défiler)'],
    ['⏎', 'ouvrir un commit (ses fichiers), puis un fichier (son diff)'],
    ['i', 'revenir à HEAD'],
    ['g', 'chercher dans le message, l’auteur, le hash ou les fichiers'],
    ['n', 'résultat suivant de la recherche ; Échap efface la recherche'],
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
]

function helpTree(ui: Ui, ctl: Controller, width: number): RenderElement {
  const { Box, Text } = ui
  const line = (text: string) => truncate(text, width)
  const keyWidth = 14

  return (
    <Box flexDirection="column">
      {keys(ui, ctl, width, 'help')}
      <Text bold>ctree · aide</Text>
      {HELP.flatMap(([title, entries]) => [
        <Text bold color="suggestion">{line(`  ${title}`)}</Text>,
        ...entries.map(([what, does]) => (
          <Text>
            <Text color="claude">{`    ${what.padEnd(keyWidth)}`}</Text>
            <Text>{truncate(does, Math.max(8, width - keyWidth - 4))}</Text>
          </Text>
        )),
      ])}
    </Box>
  )
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`
}

function diffTree(ui: Ui, ctl: Controller, mode: DiffMode, width: number): RenderElement {
  const { Box, Text, Code } = ui
  const where = mode.compare
    ? `${shortHash(mode.compare.from.hash)} → ${mode.compare.to ? shortHash(mode.compare.to.hash) : 'non commité'}`
    : mode.commit ? `${shortHash(mode.commit.hash)} ${mode.commit.subject}` : 'non commité'
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
function keys(
  ui: Ui,
  ctl: Controller,
  width: number,
  where: 'list' | 'diff' | 'message' | 'journal' | 'session' | 'compare' | 'search' | 'help',
): RenderElement {
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

  if (where === 'journal') {
    return (
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>⏎ annuler celle-ci</Text>
        {key('u', 'annuler la dernière', () => void ctl.beginUndo())}
        {key('q', 'retour', () => ctl.back())}
      </Box>
    )
  }

  if (where === 'session') {
    return (
      <Box flexDirection="row" columnGap={2}>
        {key('e', 'description de PR', () => void ctl.explain())}
        {key('q', 'retour', () => ctl.back())}
        <Text dimColor>↑↓ défiler</Text>
      </Box>
    )
  }

  if (where === 'compare') {
    return (
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>⏎ diff du fichier</Text>
        {key('e', 'expliquer', () => void ctl.explain())}
        {key('q', 'retour', () => ctl.back())}
      </Box>
    )
  }

  if (where === 'search') {
    return (
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>⏎ voir dans le graphe</Text>
        {key('g', 'nouvelle recherche', () => ctl.beginSearch())}
        {key('q', 'retour', () => ctl.back())}
      </Box>
    )
  }

  if (where === 'help') {
    return (
      <Box flexDirection="row" columnGap={2}>
        {key('q', 'retour', () => ctl.back())}
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

  const fit = fitKeys(listKeys(ctl), width, keyRows(width))
  const draw = (one: Key) =>
    one.onPress ? key(one.hotkey, fit.isLong ? one.long : one.short, one.onPress) : <Text dimColor>{keyText(one, fit.isLong)}</Text>

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={fit.gap}>
        {fit.shown.map(draw)}
        {key('h', 'aide', () => ctl.openHelp())}
      </Box>
      {/* Not drawn, still pressed by their hotkeys. */}
      <Box display="none">{fit.hidden.map(draw)}</Box>
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
