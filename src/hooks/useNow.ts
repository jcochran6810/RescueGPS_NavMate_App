import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * The current time, re-rendered every `intervalMs`.
 *
 * Countdowns have to keep moving on their own — a crew watching the time left
 * until dark should never wonder whether the number is live or frozen.
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}

/*
 * One clock for everything that judges the GPS fix's age.
 *
 * The header's GPS chip and the steering card each ran their own one-second
 * timer, started at different moments, so for up to a second after a fix
 * went stale one said "GPS lost" while the other still showed live numbers.
 * They read this shared tick instead: the same `now`, in the same render.
 */
let clockNow = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const l of clockListeners) l()
    }, 1000)
  }
  return () => {
    clockListeners.delete(cb)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

function readClock(): number {
  // Nobody ticking it: it may be long out of date. Refreshed at most once a
  // second, so two reads in one render agree.
  if (!clockTimer && Date.now() - clockNow >= 1000) clockNow = Date.now()
  return clockNow
}

/** The shared one-second clock, ms since the epoch. */
export function useClock(): number {
  return useSyncExternalStore(subscribeClock, readClock, () => Date.now())
}

/** The clock's workings, for tests: the header chip and the card subscribe to this one tick. */
export const sharedClock = { subscribe: subscribeClock, read: readClock }
