import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * `vercel.json` is validated against a strict schema **by the deployment**,
 * which is the worst possible place to find out it is wrong.
 *
 * A `"//": "…"` comment key was added to it in good faith and rejected with
 * `should NOT have additional property '//'`. Vercel does not fall back to the
 * last good build: it fails the deployment outright. So the live site stayed on
 * the commit before it while two sessions' worth of work — the ENC relay and
 * the whole compass — sat on `main` looking shipped and reaching nobody. The
 * repository was green the entire time, because nothing in the repository was
 * looking at this file.
 *
 * These checks are the thing that was missing. They run in `npm test`, which
 * means before the merge rather than after the deploy.
 */

const path = fileURLToPath(new URL('../../vercel.json', import.meta.url))
const raw = readFileSync(path, 'utf8')

/**
 * Every top-level property Vercel's schema accepts, as of writing.
 *
 * Deliberately a fixed list rather than a fetch: this test has to work offline
 * and it has to fail on a key it does not recognise, which is exactly the
 * failure it exists for. If Vercel adds a property this project wants, add it
 * here in the same commit — the point is that the decision is visible.
 */
const ALLOWED_TOP_LEVEL = new Set([
  '$schema',
  'buildCommand',
  'cleanUrls',
  'crons',
  'devCommand',
  'framework',
  'functions',
  'git',
  'headers',
  'ignoreCommand',
  'images',
  'installCommand',
  'outputDirectory',
  'public',
  'redirects',
  'regions',
  'rewrites',
  'trailingSlash',
])

/** Walk every key in the document, including inside arrays. */
function everyKey(value: unknown, seen: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) everyKey(v, seen)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      seen.push(k)
      everyKey(v, seen)
    }
  }
  return seen
}

describe('vercel.json', () => {
  it('is valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('carries no comment keys anywhere', () => {
    // JSON has no comments and Vercel's schema has no spare room for a key
    // pretending to be one. Put the reasoning in DEPLOYMENT.md instead — that
    // is where someone changing the deployment is already looking.
    const bad = everyKey(JSON.parse(raw)).filter((k) => k.startsWith('//'))
    expect(bad).toEqual([])
  })

  it('uses only top-level properties the schema knows', () => {
    const unknown = Object.keys(JSON.parse(raw)).filter(
      (k) => !ALLOWED_TOP_LEVEL.has(k),
    )
    expect(unknown).toEqual([])
  })

  it('keeps the SPA catch-all off the ENC relay', () => {
    // The rewrite that was being explained by the comment that broke the
    // build. Asserting it is better than describing it: `api/enc.js` is a real
    // function, and a catch-all that swallowed it would hand every chart query
    // an HTML page and put the plotter back to drawing straight lines through
    // land.
    const { rewrites } = JSON.parse(raw) as {
      rewrites: { source: string; destination: string }[]
    }
    const spa = rewrites.find((r) => r.destination === '/index.html')
    expect(spa).toBeDefined()
    const re = new RegExp(`^${spa!.source}$`)
    expect(re.test('/waypoints')).toBe(true)
    expect(re.test('/')).toBe(true)
    expect(re.test('/api/enc')).toBe(false)
  })
})
