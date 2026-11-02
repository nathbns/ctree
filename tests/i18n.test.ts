import { describe, expect, test } from 'claude-code/testing'

import { counts, relativeDate } from '../src/format'
import { messages, NOTES, resolveLanguage } from '../src/i18n'
import { DATE_WIDTH, textWidth } from '../src/layout'
import { inBoth, NOW } from './fixtures'

describe('which language', () => {
  test('en and fr as set; auto follows Claude Code’s language setting, then LC_ALL, LC_MESSAGES, LANG', () => {
    expect(resolveLanguage('fr', 'english', { LANG: 'en_US.UTF-8' })).toBe('fr')
    expect(resolveLanguage('en', undefined, { LANG: 'fr_FR.UTF-8' })).toBe('en')
    expect(resolveLanguage('auto', 'French', { LANG: 'en_US.UTF-8' })).toBe('fr')
    expect(resolveLanguage('auto', 'français', {})).toBe('fr')
    expect(resolveLanguage('auto', 'japanese', { LANG: 'fr_FR.UTF-8' })).toBe('en')
    expect(resolveLanguage('auto', undefined, { LC_ALL: 'fr_CA.UTF-8', LANG: 'en_US.UTF-8' })).toBe('fr')
    expect(resolveLanguage('auto', undefined, { LC_ALL: '', LC_MESSAGES: 'fr_BE', LANG: 'en_GB' })).toBe('fr')
    expect(resolveLanguage('auto', '  ', { LANG: 'fr' })).toBe('fr')
    expect(resolveLanguage('auto', undefined, { LANG: 'C.UTF-8' })).toBe('en')
    expect(resolveLanguage('auto', undefined, { LANG: 'fy_NL' })).toBe('en')
    expect(resolveLanguage(undefined, undefined, {})).toBe('en')
  })
})

describe('the two tables', () => {
  /** Every key path, and what kind of value it holds, so one table cannot miss what the other has. */
  const shape = (value: unknown, path = ''): string[] => {
    if (typeof value === 'function') return [`${path}()${value.length}`]
    if (Array.isArray(value)) return [`${path}[${value.length}]`, ...value.flatMap((item, i) => shape(item, `${path}[${i}]`))]
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => shape(item, `${path}.${key}`))

    return [`${path}:${typeof value}`]
  }

  test('English and French hold the same keys, the same functions, the same lists', () => {
    expect(shape(messages('fr'))).toEqual(shape(messages('en')))
  })

  test('the notes for Claude are English sentences, whatever the language', () => {
    expect(NOTES.switched('main')).toBe('[ctree] Through the pane, the person switched to branch main (git switch main).')
    expect(NOTES.undone('git reset --hard HEAD~1', 2, 'main 1111111 → 2222222', true)).toBe(
      '[ctree] Through the pane, the person undid your command "git reset --hard HEAD~1" (turn 2): main 1111111 → 2222222, ' +
        'and the changed files it threw away are back. The repository is back to how it was before that command.',
    )
  })
})

describe('short formats', () => {
  const ago = (seconds: number) => relativeDate(Math.floor(NOW / 1000) - seconds, NOW)
  const minute = 60
  const hour = 60 * minute
  const day = 24 * hour

  inBoth('relative dates: 2h, 1d, 3w', say => {
    expect([ago(10), ago(5 * minute), ago(3 * hour), ago(2 * day), ago(21 * day), ago(120 * day), ago(400 * day), ago(800 * day)]).toEqual(say(
      ['<1m', '5m', '3h', '2d', '3w', '4mo', '1y', '2y'],
      ['< 1 min', '5 min', '3 h', '2 j', '3 sem', '4 mois', '1 an', '2 ans'],
    ))
    expect(counts(null, null)).toBe(say('binary', 'binaire'))
  })

  inBoth('every relative date fits the date column', () => {
    for (let seconds = 0; seconds < 60 * 365 * day; seconds += seconds < day ? minute : seconds < 400 * day ? hour : 30 * day) {
      const text = ago(seconds)

      expect(`${text}: ${textWidth(text) <= DATE_WIDTH}`).toBe(`${text}: true`)
    }
  })
})
