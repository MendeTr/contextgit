import { describe, it, expect } from 'vitest'
import { normalizeThreadSubject, parseThreadOpenInput } from './threads.js'

describe('normalizeThreadSubject', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeThreadSubject('  hello  ')).toBe('hello')
  })

  it('lowercases', () => {
    expect(normalizeThreadSubject('Foo BAR Baz')).toBe('foo bar baz')
  })

  it('collapses internal whitespace runs', () => {
    expect(normalizeThreadSubject('foo   bar\tbaz\n qux')).toBe('foo bar baz qux')
  })

  it('returns equal forms for casing + spacing variants', () => {
    const a = normalizeThreadSubject('  Write Plan B Extension')
    const b = normalizeThreadSubject('write plan b extension')
    const c = normalizeThreadSubject('Write  Plan  B  Extension ')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('treats distinct subjects as distinct', () => {
    expect(normalizeThreadSubject('foo')).not.toBe(normalizeThreadSubject('bar'))
  })
})

describe('parseThreadOpenInput', () => {
  it('coerces a plain string to {subject, kind: "open"}', () => {
    expect(parseThreadOpenInput('hello')).toEqual({ subject: 'hello', kind: 'open' })
  })

  it('passes through an object with kind set', () => {
    expect(parseThreadOpenInput({ subject: 'note', kind: 'watch' })).toEqual({ subject: 'note', kind: 'watch' })
  })

  it('defaults kind to "open" when an object omits it', () => {
    expect(parseThreadOpenInput({ subject: 'note' })).toEqual({ subject: 'note', kind: 'open' })
  })
})
