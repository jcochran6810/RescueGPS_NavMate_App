import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/native', () => ({
  isNativeApp: () => true,
  appOrigin: () => 'https://navmate.example',
  PUBLIC_ORIGIN: 'https://navmate.example',
}))
vi.mock('@/lib/version', async (orig) => {
  const real = await orig<typeof import('@/lib/version')>()
  return { ...real, isNewer: (live: unknown) => real.isNewer(live, 'a'.repeat(40)) }
})

const { useUpdate } = await import('./useUpdate')

function liveIs(sha: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sha }))))
}

afterEach(() => {
  vi.unstubAllGlobals()
  useUpdate.setState({ available: false, kind: null, snoozed: null, liveSha: null })
})

describe('Android update check', () => {
  it('offers an update when the live site is on a newer build', async () => {
    liveIs('b'.repeat(40))
    await useUpdate.getState().checkNative()
    expect(useUpdate.getState()).toMatchObject({ available: true, kind: 'native' })
  })

  it('stays quiet when this is the live build', async () => {
    liveIs('a'.repeat(40))
    await useUpdate.getState().checkNative()
    expect(useUpdate.getState().available).toBe(false)
  })

  it('stays quiet when the site cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await useUpdate.getState().checkNative()
    expect(useUpdate.getState().available).toBe(false)
  })

  it('"Later" holds until a different new version appears', async () => {
    liveIs('b'.repeat(40))
    await useUpdate.getState().checkNative()
    useUpdate.getState().later()
    expect(useUpdate.getState().available).toBe(false)
    await useUpdate.getState().checkNative()
    expect(useUpdate.getState().available).toBe(false)
    liveIs('c'.repeat(40))
    await useUpdate.getState().checkNative()
    expect(useUpdate.getState().available).toBe(true)
  })
})
