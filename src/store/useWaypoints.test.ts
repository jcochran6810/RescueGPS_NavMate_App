import { describe, it, expect, beforeEach } from 'vitest'
import { useWaypoints } from './useWaypoints'
import type { Waypoint } from '@/lib/types'

function waypoint(id: string, over: Partial<Waypoint> = {}): Waypoint {
  return {
    id,
    user_id: 'u1',
    team_id: null,
    name: id,
    lat: 30,
    lon: -95,
    note: '',
    photos: [],
    created_at: `2026-08-0${id.slice(-1)}T00:00:00.000Z`,
    updated_at: `2026-08-0${id.slice(-1)}T00:00:00.000Z`,
    ...over,
  }
}

beforeEach(() => {
  useWaypoints.setState({ cache: [], pending: [] })
})

describe('visible', () => {
  it('returns the same array until something actually changes', () => {
    // This is the whole reason the merge is memoised. `visible()` is read as a
    // Zustand selector, and React compares what a selector returns between
    // renders with Object.is. A fresh array every call reads as "the store
    // changed" forever, so the component re-renders without end and the tab
    // paints nothing at all.
    useWaypoints.setState({ cache: [waypoint('a1')], pending: [] })

    const first = useWaypoints.getState().visible()
    const second = useWaypoints.getState().visible()
    expect(second).toBe(first)
  })

  it('returns a new array once the cache changes', () => {
    useWaypoints.setState({ cache: [waypoint('a1')], pending: [] })
    const before = useWaypoints.getState().visible()

    useWaypoints.setState({ cache: [waypoint('a1'), waypoint('a2')] })
    const after = useWaypoints.getState().visible()

    expect(after).not.toBe(before)
    expect(after).toHaveLength(2)
  })

  it('returns a new array once the queue changes', () => {
    useWaypoints.setState({ cache: [waypoint('a1')], pending: [] })
    const before = useWaypoints.getState().visible()

    useWaypoints.setState({
      pending: [{ kind: 'delete', id: 'a1' }],
    })
    const after = useWaypoints.getState().visible()

    expect(after).not.toBe(before)
    expect(after).toHaveLength(0)
  })

  it('lays queued writes over the cached server state', () => {
    useWaypoints.setState({
      cache: [waypoint('a1', { name: 'Old' }), waypoint('a2')],
      pending: [
        { kind: 'update', id: 'a1', patch: { name: 'New' } },
        { kind: 'delete', id: 'a2' },
        { kind: 'create', waypoint: waypoint('a3') },
      ],
    })

    const shown = useWaypoints.getState().visible()
    expect(shown.map((w) => w.id).sort()).toEqual(['a1', 'a3'])
    expect(shown.find((w) => w.id === 'a1')?.name).toBe('New')
  })

  it('sorts newest first', () => {
    useWaypoints.setState({
      cache: [waypoint('a1'), waypoint('a3'), waypoint('a2')],
    })
    expect(useWaypoints.getState().visible().map((w) => w.id)).toEqual([
      'a3',
      'a2',
      'a1',
    ])
  })

  it('ignores an update queued against a waypoint that is gone', () => {
    useWaypoints.setState({
      cache: [],
      pending: [{ kind: 'update', id: 'missing', patch: { name: 'X' } }],
    })
    expect(useWaypoints.getState().visible()).toHaveLength(0)
  })
})
