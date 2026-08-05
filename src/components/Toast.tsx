import { useEffect } from 'react'
import { useToast } from '@/store/useToast'

const TONE = {
  info: 'bg-navy-800 text-slate-100 border-white/15',
  success: 'bg-emerald-600 text-white border-emerald-400/40',
  error: 'bg-red-600 text-white border-red-400/40',
} as const

export function Toast() {
  const { message, tone, seq, clear } = useToast()

  useEffect(() => {
    if (!message) return
    const t = setTimeout(clear, tone === 'error' ? 5000 : 2600)
    return () => clearTimeout(t)
  }, [seq, message, tone, clear])

  if (!message) return null

  return (
    <div
      role="status"
      aria-live="polite"
      // Clears the footer, which is now the stamp button and the section row
      // stacked, not the section row alone.
      className="pointer-events-none fixed inset-x-0 bottom-32 z-50 flex justify-center px-4"
    >
      <div
        className={
          'pointer-events-auto max-w-sm rounded-xl border px-4 py-2.5 text-sm ' +
          'shadow-xl shadow-black/40 ' +
          TONE[tone]
        }
      >
        {message}
      </div>
    </div>
  )
}
