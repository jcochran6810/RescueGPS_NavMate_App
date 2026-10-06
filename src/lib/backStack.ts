/**
 * The back button.
 *
 * NavMate is one page with its sections held in React state, so until this
 * existed the phone's back gesture had nothing to go back *to*: it left the
 * app. This keeps the browser's own history in step with the section the crew
 * is looking at, so the hardware back button, the swipe, the browser's arrow
 * and NavMate's own ← all mean the same thing — the screen you were on before.
 *
 * Two kinds of entry go on the history stack:
 *
 *  - a **page** — every move to a different section pushes one;
 *  - an **overlay** — a sheet, the menu, the account panel, a full-screen map.
 *    Back closes the thing on top before it changes the page underneath,
 *    which is what anyone pressing back on a phone with a sheet open expects.
 *    Without it, back changed the page *behind* a sheet that stayed open.
 *
 * The browser's history API is asynchronous in one direction only:
 * `pushState` happens at once, `history.go()` lands later with a `popstate`.
 * Mixing the two in the wrong order pops the entry that was just pushed —
 * a sheet closing (go back one) and a section opening (push) in the same tap
 * is exactly that. So every change is an operation in a queue, run one at a
 * time, and a traversal holds the queue until its `popstate` arrives.
 *
 * An overlay closed by its own ✕ while it is *not* the top entry (a section
 * was opened from inside it) is left in place as a **stale** entry. Landing
 * on one — by the crew pressing back — steps straight over it, so it costs a
 * traversal nobody sees rather than a back press that appears to do nothing.
 *
 * Pure apart from the `HistoryLike` it is handed, so it is tested against a
 * fake history in `backStack.test.ts`.
 */

export interface HistoryLike {
  readonly state: unknown
  pushState(data: unknown, unused: string): void
  replaceState(data: unknown, unused: string): void
  go(delta: number): void
}

interface EntryState {
  navmate: 1
  idx: number
  tab: string
  /** `<load>:<n>` — unique per page load, so a reload never mistakes an old entry for a live overlay. */
  overlay?: string
}

type Op =
  | { kind: 'push'; tab: string; overlay?: string }
  | { kind: 'back'; asUser: boolean }

interface Overlay {
  /** Its history entry's index once pushed; null while the push is queued. */
  idx: number | null
  close: () => void
}

export interface BackStack {
  /** The section on screen. */
  tab(): string
  /** Whether ← has somewhere to go. */
  canGoBack(): boolean
  /** Open a section. Opening the one already on screen does nothing. */
  navigate(tab: string): void
  /** The screen before this one — or Home, when nothing is behind. */
  back(): void
  /** An overlay opened: back now closes it first. Returns its key. */
  openOverlay(close: () => void): string
  /** The overlay closed by its own control (or unmounted). */
  releaseOverlay(key: string): void
  /** Feed the window's `popstate` here. */
  onPopState(state: unknown): void
  subscribe(fn: () => void): () => void
}

function isEntry(s: unknown): s is EntryState {
  return (
    typeof s === 'object' &&
    s !== null &&
    (s as EntryState).navmate === 1 &&
    typeof (s as EntryState).idx === 'number' &&
    typeof (s as EntryState).tab === 'string'
  )
}

export function createBackStack(o: {
  history: HistoryLike
  home: string
  /** The section to open on, overriding a restored one (a passage being steered). */
  initial?: string | null
  /** Sections this build knows; a restored entry naming another opens Home. */
  isTab: (tab: string) => boolean
  /** Give up waiting for a traversal's popstate after this long (ms). */
  traversalTimeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
}): BackStack {
  const h = o.history
  const loadKey = Math.random().toString(36).slice(2, 8)
  const timeoutMs = o.traversalTimeoutMs ?? 1500
  const setT = o.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearT = o.clearTimeout ?? ((t) => globalThis.clearTimeout(t as number))

  let tab = o.home
  let idx = 0
  let nextOverlay = 1
  const overlays = new Map<string, Overlay>()
  const queue: Op[] = []
  let inFlight: { asUser: boolean; timer: unknown } | null = null
  const listeners = new Set<() => void>()

  const notify = () => listeners.forEach((fn) => fn())
  const valid = (t: string) => (o.isTab(t) ? t : o.home)

  // ---- start: adopt a restored entry (a reload keeps its section), or make the root one.
  const restored = h.state
  if (isEntry(restored)) {
    idx = restored.idx
    tab = valid(restored.tab)
    if (o.initial && o.initial !== tab) {
      tab = valid(o.initial)
      h.replaceState({ navmate: 1, idx, tab } satisfies EntryState, '')
    } else if (restored.overlay) {
      // Reloaded with a sheet's entry on top: nothing is open now, so this
      // entry would make the first back press do nothing. Make it a page.
      h.replaceState({ navmate: 1, idx, tab } satisfies EntryState, '')
    }
  } else {
    tab = valid(o.initial ?? o.home)
    h.replaceState({ navmate: 1, idx: 0, tab } satisfies EntryState, '')
  }

  function drain() {
    while (!inFlight && queue.length > 0) {
      const op = queue.shift()!
      if (op.kind === 'push') {
        idx += 1
        const state: EntryState = { navmate: 1, idx, tab: op.tab }
        if (op.overlay) {
          state.overlay = op.overlay
          const ov = overlays.get(op.overlay)
          if (ov) ov.idx = idx
        }
        h.pushState(state, '')
      } else {
        if (idx <= 0) continue
        const timer = setT(() => {
          // The popstate never came. Resynchronise from what the browser
          // says rather than wedge every later navigation behind it.
          if (!inFlight) return
          inFlight = null
          const s = h.state
          if (isEntry(s)) idx = s.idx
          drain()
        }, timeoutMs)
        inFlight = { asUser: op.asUser, timer }
        h.go(-1)
      }
    }
  }

  function enqueue(op: Op, front = false) {
    if (front) queue.unshift(op)
    else queue.push(op)
    drain()
  }

  function isStale(s: EntryState) {
    return !!s.overlay && !overlays.has(s.overlay)
  }

  /** The crew went back (or forward) by themselves. */
  function userLanded(s: EntryState | null) {
    const newIdx = s?.idx ?? 0
    // Everything above where they landed is gone: close those overlays, top first.
    const above = [...overlays.entries()]
      .filter(([, ov]) => ov.idx !== null && ov.idx > newIdx)
      .sort((a, b) => (b[1].idx ?? 0) - (a[1].idx ?? 0))
    for (const [key, ov] of above) {
      overlays.delete(key)
      ov.close()
    }
    idx = newIdx
    const nextTab = valid(s?.tab ?? o.home)
    const changed = nextTab !== tab
    tab = nextTab
    if (s && isStale(s)) enqueue({ kind: 'back', asUser: false }, true)
    if (changed || above.length > 0) notify()
  }

  return {
    tab: () => tab,
    canGoBack: () => idx > 0 || tab !== o.home,

    navigate(next) {
      next = valid(next)
      if (next === tab) return
      tab = next
      enqueue({ kind: 'push', tab: next })
      notify()
    },

    back() {
      if (idx > 0 || inFlight || queue.length > 0) {
        enqueue({ kind: 'back', asUser: true })
        return
      }
      if (tab === o.home) return
      // Nothing behind (the app opened straight onto this section): Home,
      // in place of this entry, so a further back leaves the app as expected.
      tab = o.home
      h.replaceState({ navmate: 1, idx, tab } satisfies EntryState, '')
      notify()
    },

    openOverlay(close) {
      const key = `${loadKey}:${nextOverlay++}`
      overlays.set(key, { idx: null, close })
      enqueue({ kind: 'push', tab, overlay: key })
      return key
    },

    releaseOverlay(key) {
      const ov = overlays.get(key)
      if (!ov) return // already closed by a back press
      overlays.delete(key)
      if (ov.idx === null) {
        // Its push never ran — drop it rather than push and pop for nothing.
        const i = queue.findIndex((op) => op.kind === 'push' && op.overlay === key)
        if (i >= 0) queue.splice(i, 1)
        return
      }
      // On top: take its entry off, so the next back press means something.
      // Underneath something else: leave it; landing on it steps over it.
      const pendingPushes = queue.some((op) => op.kind === 'push')
      if (ov.idx === idx && !pendingPushes) enqueue({ kind: 'back', asUser: false })
    },

    onPopState(raw) {
      const s = isEntry(raw) ? raw : null
      if (inFlight) {
        const { asUser, timer } = inFlight
        clearT(timer)
        inFlight = null
        if (asUser) {
          userLanded(s)
        } else {
          idx = s?.idx ?? 0
          if (s && isStale(s)) queue.unshift({ kind: 'back', asUser: false })
        }
        drain()
        return
      }
      userLanded(s)
      drain()
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
