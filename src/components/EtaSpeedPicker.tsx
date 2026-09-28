import { useId, useState } from 'react'
import { useFormat } from '@/hooks/useFormat'
import {
  ETA_SPEED_LABEL,
  ETA_SPEED_MODES,
  parseCustomSpeed,
  speedText,
  type EtaSpeedMode,
} from '@/lib/etaSpeed'
import { knotsIn, SPEED_SUFFIX } from '@/lib/units'
import { useEtaSpeed } from '@/store/useEtaSpeed'

/**
 * "ETA at: Current · Cruise · Top · Custom" — which speed the time to go and
 * the arrival clock are worked at. On the steering card and under a planned
 * route. Four buttons that fit a 320 px card, and a speed box under them for
 * Custom, in the crew's own speed unit, checked as it is typed.
 */
export function EtaSpeedPicker({
  cruiseKn,
  topKn,
  className = '',
}: {
  cruiseKn: number | null
  topKn: number | null
  className?: string
}) {
  const mode = useEtaSpeed((s) => s.mode)
  const customKn = useEtaSpeed((s) => s.customKn)
  const setMode = useEtaSpeed((s) => s.setMode)
  const setCustomKn = useEtaSpeed((s) => s.setCustomKn)
  const fmt = useFormat()
  const unit = fmt.units.speed
  const id = useId()
  const [text, setText] = useState(() =>
    customKn != null ? String(Math.round(knotsIn(customKn, unit) * 10) / 10) : '',
  )
  const [error, setError] = useState<string | null>(null)

  const hint = (m: EtaSpeedMode): string | undefined => {
    if (m === 'cruise') return cruiseKn != null ? speedText(cruiseKn, unit) : 'not set'
    if (m === 'top') return topKn != null ? speedText(topKn, unit) : 'not set'
    if (m === 'custom') return customKn != null ? speedText(customKn, unit) : undefined
    return undefined
  }

  const commit = (value: string) => {
    setText(value)
    const r = parseCustomSpeed(value, unit)
    if (r.error) {
      setError(r.error)
      return
    }
    setError(null)
    setCustomKn(r.kn)
  }

  return (
    <div className={className}>
      <div
        role="radiogroup"
        aria-label="Speed the ETA is worked at"
        className="grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-white/5 p-1"
      >
        {ETA_SPEED_MODES.map((m) => {
          const on = m === mode
          const h = hint(m)
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMode(m)}
              className={
                'min-h-11 min-w-0 rounded-lg px-1 py-1 text-center text-xs leading-tight font-semibold ' +
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400 ' +
                (on ? 'bg-sky-500 text-navy-950' : 'text-slate-200 hover:bg-white/10')
              }
            >
              <span className="block">{ETA_SPEED_LABEL[m]}</span>
              {h && (
                <span className={'block truncate text-[10px] font-normal ' + (on ? 'text-navy-900' : 'text-slate-400')}>
                  {h}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {mode === 'custom' && (
        <div className="mt-2">
          <label htmlFor={id} className="block text-xs font-semibold text-slate-300">
            {`Custom speed (${SPEED_SUFFIX[unit]})`}
          </label>
          <input
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            placeholder="e.g. 18"
            aria-invalid={error != null}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => commit(e.target.value)}
            className={
              'mt-1 w-full min-w-0 rounded-lg border bg-navy-950 px-3 py-2 text-base text-slate-50 ' +
              (error ? 'border-red-400' : 'border-white/15')
            }
          />
          {error && (
            <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
