import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react'

type Variant = 'primary' | 'default' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-sky-500 text-navy-950 hover:bg-sky-400 active:bg-sky-600 font-semibold',
  default:
    'bg-white/10 text-slate-100 hover:bg-white/15 active:bg-white/20 border border-white/10',
  ghost:
    'bg-transparent text-slate-300 hover:bg-white/5 active:bg-white/10 border border-white/10',
  danger:
    'bg-red-600/90 text-white hover:bg-red-600 active:bg-red-700 font-semibold',
}

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 ' +
        'text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
        VARIANTS[variant] +
        ' ' +
        className
      }
    />
  )
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={
        'rounded-2xl border border-white/10 bg-navy-900/70 p-4 shadow-lg shadow-black/20 ' +
        className
      }
    >
      {children}
    </div>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-400 uppercase">
      {children}
    </span>
  )
}

export function Input({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        'min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 ' +
        'text-slate-100 placeholder:text-slate-500 ' +
        'focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20 focus:outline-none ' +
        'disabled:opacity-60 read-only:text-slate-300 ' +
        className
      }
    />
  )
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-navy-900/60 px-3 py-2.5">
      <div className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div className="tnum mt-0.5 text-lg font-semibold text-slate-50">
        {value}
      </div>
      {hint ? <div className="text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={
        'inline-block size-4 animate-spin rounded-full border-2 ' +
        'border-current border-t-transparent ' +
        className
      }
    />
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-400">
      {children}
    </p>
  )
}
