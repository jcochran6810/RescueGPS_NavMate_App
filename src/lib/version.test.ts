import { describe, expect, it } from 'vitest'
import { isNewer, versionLabel } from './version'

describe('isNewer', () => {
  it('is newer when the live site serves another commit', () => {
    expect(isNewer({ sha: 'b'.repeat(40) }, 'a'.repeat(40))).toBe(true)
  })
  it('is not newer on the same commit', () => {
    expect(isNewer({ sha: 'a'.repeat(40) }, 'a'.repeat(40))).toBe(false)
  })
  it('never raises an alarm on missing, malformed or dev answers', () => {
    expect(isNewer(null, 'a'.repeat(40))).toBe(false)
    expect(isNewer({}, 'a'.repeat(40))).toBe(false)
    expect(isNewer({ sha: 'dev' }, 'a'.repeat(40))).toBe(false)
    expect(isNewer({ sha: 'abc' }, 'a'.repeat(40))).toBe(false)
    expect(isNewer({ sha: 'b'.repeat(40) }, 'dev')).toBe(false)
  })
})

describe('versionLabel', () => {
  it('shows the app version, date and short commit', () => {
    const s = versionLabel('1.0.10', 'fdc2f4a8888abe9d6a4c', '2026-11-24T13:40:00Z')
    expect(s).toMatch(/^1\.0\.10 · .+2026 · fdc2f4a$/)
  })
  it('names a development build', () => {
    expect(versionLabel(null, 'dev', null)).toBe('development build')
  })
})
