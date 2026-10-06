import { describe, expect, it, vi } from 'vitest'
import { createBackStack, type BackStack, type HistoryLike } from './backStack'

/**
 * A browser history in miniature: pushState truncates the forward entries and
 * is immediate; go() lands later, with a popstate — the asymmetry the queue
 * in backStack exists for.
 */
function fakeHistory(initialState: unknown = null) {
  const entries: unknown[] = [initialState]
  let index = 0
  let onPop: (s: unknown) => void = () => {}
  const pendingGo: number[] = []
  const h: HistoryLike & {
    entries: unknown[]
    readonly index: number
    flush(): void
    press(delta?: number): void
    listen(fn: (s: unknown) => void): void
  } = {
    entries,
    get index() {
      return index
    },
    get state() {
      return entries[index]
    },
    pushState(data) {
      entries.splice(index + 1)
      entries.push(data)
      index += 1
    },
    replaceState(data) {
      entries[index] = data
    },
    go(delta) {
      pendingGo.push(delta)
    },
    /** Deliver queued traversals, as the browser would on its next task. */
    flush() {
      while (pendingGo.length > 0) {
        const d = pendingGo.shift()!
        const target = Math.max(0, Math.min(entries.length - 1, index + d))
        if (target === index) continue
        index = target
        onPop(entries[index])
      }
    },
    /** The crew pressing the phone's back button (or forward, with +1). */
    press(delta = -1) {
      const target = index + delta
      if (target < 0 || target >= entries.length) return
      index = target
      onPop(entries[index])
      h.flush()
    },
    listen(fn) {
      onPop = fn
    },
  }
  return h
}

const TABS = ['home', 'chart', 'compass', 'datum', 'search']

function setup(o: { initial?: string | null; state?: unknown } = {}) {
  const h = fakeHistory(o.state ?? null)
  const nav = createBackStack({
    history: h,
    home: 'home',
    initial: o.initial,
    isTab: (t) => TABS.includes(t),
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  h.listen((s) => nav.onPopState(s))
  return { h, nav }
}

/** Open an overlay the way a component does: `close` flips its open flag. */
function overlay(nav: BackStack) {
  const state = { open: true, key: '' }
  state.key = nav.openOverlay(() => {
    state.open = false
  })
  return state
}

describe('backStack — pages', () => {
  it('starts on Home with nothing behind it', () => {
    const { nav, h } = setup()
    expect(nav.tab()).toBe('home')
    expect(nav.canGoBack()).toBe(false)
    expect(h.entries).toHaveLength(1)
  })

  it('back returns to the previous section, one at a time', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    nav.navigate('compass')
    expect(nav.tab()).toBe('compass')
    h.press()
    expect(nav.tab()).toBe('chart')
    h.press()
    expect(nav.tab()).toBe('home')
    expect(nav.canGoBack()).toBe(false)
  })

  it('the in-app arrow goes to the same place as the phone button', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    nav.navigate('datum')
    nav.back()
    h.flush()
    expect(nav.tab()).toBe('chart')
    nav.back()
    h.flush()
    expect(nav.tab()).toBe('home')
  })

  it('Home is an ordinary section: back from it goes to where the crew was', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    nav.navigate('home')
    h.press()
    expect(nav.tab()).toBe('chart')
  })

  it('opening the section already on screen adds no entry', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    nav.navigate('chart')
    expect(h.entries).toHaveLength(2)
  })

  it('an app opened straight onto a section: ← goes Home in place', () => {
    const { nav, h } = setup({ initial: 'chart' })
    expect(nav.tab()).toBe('chart')
    expect(nav.canGoBack()).toBe(true)
    nav.back()
    expect(nav.tab()).toBe('home')
    expect(h.entries).toHaveLength(1)
  })

  it('a reload keeps the section and the entries behind it', () => {
    const first = setup()
    first.nav.navigate('chart')
    first.nav.navigate('compass')
    // Reload: same history, new instance.
    const h = first.h
    const nav = createBackStack({
      history: h,
      home: 'home',
      isTab: (t) => TABS.includes(t),
    })
    h.listen((s) => nav.onPopState(s))
    expect(nav.tab()).toBe('compass')
    h.press()
    expect(nav.tab()).toBe('chart')
  })

  it('a restored section this build does not know opens Home', () => {
    const { nav } = setup({ state: { navmate: 1, idx: 0, tab: 'gone' } })
    expect(nav.tab()).toBe('home')
  })

  it('a passage being steered overrides the restored section', () => {
    const { nav } = setup({ initial: 'chart', state: { navmate: 1, idx: 3, tab: 'compass' } })
    expect(nav.tab()).toBe('chart')
  })

  it('an entry that is not NavMate’s reads as Home', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    h.entries[0] = {}
    h.press()
    expect(nav.tab()).toBe('home')
  })

  it('tells subscribers when the section changes', () => {
    const { nav, h } = setup()
    const fn = vi.fn()
    nav.subscribe(fn)
    nav.navigate('chart')
    h.press()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('backStack — overlays', () => {
  it('back closes an open sheet and leaves the section alone', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    const sheet = overlay(nav)
    h.press()
    expect(sheet.open).toBe(false)
    expect(nav.tab()).toBe('chart')
    // …and the next back press is a real one.
    h.press()
    expect(nav.tab()).toBe('home')
  })

  it('a sheet closed by its own ✕ takes its entry with it', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    const sheet = overlay(nav)
    nav.releaseOverlay(sheet.key)
    h.flush()
    expect(h.index).toBe(1)
    h.press()
    expect(nav.tab()).toBe('home')
  })

  it('a sheet in a sheet: back closes the inner one only', () => {
    const { nav, h } = setup()
    const outer = overlay(nav)
    const inner = overlay(nav)
    h.press()
    expect(inner.open).toBe(false)
    expect(outer.open).toBe(true)
    h.press()
    expect(outer.open).toBe(false)
  })

  it('a section opened from inside a sheet: one back press returns to the page underneath', () => {
    // The map's "Navigate here": the sheet closes and the chart opens in one
    // tap — the push lands first, then the sheet's cleanup releases it.
    const { nav, h } = setup()
    nav.navigate('datum')
    const sheet = overlay(nav)
    nav.navigate('chart')
    sheet.open = false
    nav.releaseOverlay(sheet.key)
    h.flush()
    expect(nav.tab()).toBe('chart')
    h.press()
    expect(nav.tab()).toBe('datum')
    // The stale sheet entry was stepped over, not left as a dead press.
    h.press()
    expect(nav.tab()).toBe('home')
  })

  it('a sheet closing before a section opens does not pop the new section', () => {
    // The other order: the release queues a traversal, then a push arrives
    // before the traversal lands. The push must wait for it.
    const { nav, h } = setup()
    const menu = overlay(nav)
    nav.releaseOverlay(menu.key)
    nav.navigate('compass')
    h.flush()
    expect(nav.tab()).toBe('compass')
    expect(h.index).toBe(1)
    h.press()
    expect(nav.tab()).toBe('home')
  })

  it('a sheet opened and closed in the same breath leaves no entry (StrictMode)', () => {
    const { nav, h } = setup()
    const a = overlay(nav)
    nav.releaseOverlay(a.key)
    const b = overlay(nav)
    h.flush()
    expect(h.index).toBe(1)
    h.press()
    expect(b.open).toBe(false)
    expect(h.index).toBe(0)
  })

  it('releasing an overlay back already closed does nothing', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    const sheet = overlay(nav)
    h.press()
    nav.releaseOverlay(sheet.key)
    h.flush()
    expect(nav.tab()).toBe('chart')
    expect(h.index).toBe(1)
  })

  it('a reload on top of a sheet’s entry does not leave a dead back press', () => {
    const first = setup()
    first.nav.navigate('chart')
    overlay(first.nav)
    const h = first.h
    const nav = createBackStack({ history: h, home: 'home', isTab: (t) => TABS.includes(t) })
    h.listen((s) => nav.onPopState(s))
    expect(nav.tab()).toBe('chart')
    h.press()
    // Lands on chart's own entry — same section, but the next press goes Home.
    h.press()
    expect(nav.tab()).toBe('home')
  })

  it('pressing forward onto a closed sheet’s entry steps back off it', () => {
    const { nav, h } = setup()
    nav.navigate('chart')
    overlay(nav)
    h.press() // closes it
    h.press(+1) // forward onto its stale entry
    expect(nav.tab()).toBe('chart')
    expect(h.index).toBe(1)
  })

  it('a traversal whose popstate never arrives does not wedge navigation', () => {
    const h = fakeHistory()
    const timers: (() => void)[] = []
    const nav = createBackStack({
      history: h,
      home: 'home',
      isTab: (t) => TABS.includes(t),
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    })
    h.listen((s) => nav.onPopState(s))
    nav.navigate('chart')
    nav.back() // h.go is swallowed: never flushed
    nav.navigate('compass') // queued behind it
    expect(h.index).toBe(1)
    timers.forEach((t) => t())
    expect(nav.tab()).toBe('compass')
    expect(h.index).toBe(2)
  })
})
