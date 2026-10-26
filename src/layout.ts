// Terminal cell widths, truncation, and which columns fit a given width.

/** Columns a character takes in a terminal: 0, 1 or 2. */
export function charWidth(code: number): number {
  if (
    code === 0 ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x20e3
  ) {
    return 0
  }

  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)

  return isWide ? 2 : 1
}

/** Columns a string takes in a terminal. */
export function textWidth(text: string): number {
  let width = 0

  for (const char of text) {
    width += charWidth(char.codePointAt(0) ?? 0)
  }

  return width
}

/** `text` cut to `width` columns, an ellipsis marking the cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  if (textWidth(text) <= width) {
    return text
  }

  let out = ''
  let used = 0

  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0)

    if (used + w > width - 1) {
      break
    }

    out += char
    used += w
  }

  return `${out}…`
}

/** `text` cut from the start (`…/dir/file.ts`), for paths. */
export function truncateStart(text: string, width: number): string {
  if (textWidth(text) <= width) {
    return text
  }

  const chars = [...text]
  let out = ''
  let used = 0

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i] ?? ''
    const w = charWidth(char.codePointAt(0) ?? 0)

    if (used + w > width - 1) {
      break
    }

    out = char + out
    used += w
  }

  return width <= 0 ? '' : `…${out}`
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - textWidth(text)))
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - textWidth(text))) + text
}

/** The secondary columns a row shows; hidden ones leave their room to the message. */
export type Columns = { author: boolean; date: boolean; hash: boolean }

export const AUTHOR_WIDTH = 10
export const DATE_WIDTH = 7
export const HASH_WIDTH = 7
export const GAP = 2

/** Author goes first under 84 columns, then the hash under 72, the date under 60. */
export function columnsFor(width: number): Columns {
  return { author: width >= 84, hash: width >= 72, date: width >= 60 }
}

/** Columns the visible secondary columns take, gaps included. */
export function sideWidth(columns: Columns): number {
  return (
    (columns.author ? GAP + AUTHOR_WIDTH : 0) +
    (columns.date ? GAP + DATE_WIDTH : 0) +
    (columns.hash ? GAP + HASH_WIDTH : 0)
  )
}

/** The widest the graph may grow: four tenths of the row. */
export function graphLimit(width: number): number {
  return Math.max(6, Math.floor(width * 0.4))
}
