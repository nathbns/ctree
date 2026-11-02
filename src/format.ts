// Small formatters for the pane, in the language set.

import { t } from './i18n'

/** `2h`, `1d`, `3w`, `4mo` (`2 h`, `1 j`, `3 sem`, `4 mois` in French): at most 7 columns. */
export function relativeDate(seconds: number, nowMs: number): string {
  const elapsed = Math.max(0, Math.floor(nowMs / 1000) - seconds)
  const minutes = Math.floor(elapsed / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const date = t().date

  if (minutes < 1) return date.now
  if (hours < 1) return date.minutes(minutes)
  if (days < 1) return date.hours(hours)
  if (days < 7) return date.days(days)
  if (days < 30) return date.weeks(Math.floor(days / 7))
  if (days < 365) return date.months(Math.max(1, Math.floor(days / 30)))

  return date.years(Math.floor(days / 365))
}

/** `2026-10-26 14:03`, in UTC so it reads the same everywhere. */
export function absoluteDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

/** The author's first name, or the whole name when it has one word. */
export function shortAuthor(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''

  return first.length >= 2 ? first : name.trim()
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

/** `+12 −3`, `+120`, `−40`, or `binary`. */
export function counts(added: number | null, deleted: number | null): string {
  if (added === null || deleted === null) {
    return t().binary
  }

  return [added > 0 ? `+${added}` : '', deleted > 0 ? `−${deleted}` : ''].filter(Boolean).join(' ')
}

/** The letter a file's status shows, as VS Code shows it: U untracked, ! conflicted. */
export function statusLetter(status: string): string {
  if (status === '?') return 'U'
  if (status === 'U') return '!'
  if (status === 'T') return 'M'

  return status
}
