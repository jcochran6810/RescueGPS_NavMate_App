import { useEffect, useState } from 'react'

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
