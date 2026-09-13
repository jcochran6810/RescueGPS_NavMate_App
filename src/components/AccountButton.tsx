import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '@/store/useAuth'
import { useWaypoints } from '@/store/useWaypoints'
import { toast } from '@/store/useToast'
import { Button, Input, Spinner } from '@/components/ui'

/**
 * The account: a small circle in the top right, showing the user's initials.
 * Opens a panel with the profile (name and callsign, editable) and sign out.
 */
export function AccountButton() {
  const { profile, user, updateProfile, signOut } = useAuth()
  const pending = useWaypoints((s) => s.pending.length)

  const [open, setOpen] = useState(false)
  const [fullName, setFullName] = useState('')
  const [callsign, setCallsign] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setCallsign(profile?.call_sign ?? '')
  }, [profile?.full_name, profile?.call_sign])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const label =
    profile?.call_sign || profile?.full_name || user?.email || 'Account'

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account — ${label}`}
        className="grid size-9 shrink-0 place-items-center rounded-full border border-sky-400/40 bg-sky-500/15 text-xs font-bold text-sky-200 hover:bg-sky-500/25"
      >
        {initials(profile?.full_name, profile?.call_sign, user?.email)}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={() => setOpen(false)}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Your account"
              onClick={(e) => e.stopPropagation()}
              className="safe-top absolute top-0 right-0 m-2 w-[min(20rem,calc(100vw-1rem))] rounded-2xl border border-white/10 bg-navy-900 p-4 shadow-2xl shadow-black/50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-slate-300">
                  {user?.email}
                </span>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close the account panel"
                  className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"
                >
                  ✕
                </button>
              </div>

              <div className="mt-3 space-y-2">
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Name"
                  aria-label="Your name"
                />
                <Input
                  value={callsign}
                  onChange={(e) => setCallsign(e.target.value)}
                  placeholder="Callsign"
                  aria-label="Your callsign"
                />
                <Button
                  className="w-full"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true)
                    try {
                      const { error } = await updateProfile({
                        full_name: fullName.trim(),
                        call_sign: callsign.trim(),
                      })
                      toast(error ?? 'Profile saved', error ? 'error' : 'success')
                    } finally {
                      setSaving(false)
                    }
                  }}
                >
                  {saving && <Spinner />} Save profile
                </Button>
                <p className="text-xs text-slate-400">
                  Teammates see this next to waypoints you share.
                </p>
              </div>

              <Button
                variant="ghost"
                className="mt-3 w-full"
                onClick={() => {
                  // Signing out does not destroy the queue (it stays on the
                  // device, guarded by ownerId), but nothing will sync until
                  // this account signs back in — worth a warning.
                  if (
                    pending > 0 &&
                    !confirm(
                      `${pending} change${pending === 1 ? '' : 's'} have not synced yet. ` +
                        'They stay saved on this device and sync next time you ' +
                        'sign in here. Sign out anyway?',
                    )
                  )
                    return
                  setOpen(false)
                  void signOut()
                }}
              >
                Sign out
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** Two letters for the circle: callsign first, then name, then email. */
function initials(
  fullName?: string | null,
  callsign?: string | null,
  email?: string | null,
): string {
  const cs = (callsign ?? '').trim()
  if (cs) return cs.slice(0, 2).toUpperCase()
  const name = (fullName ?? '').trim()
  if (name) {
    const parts = name.split(/\s+/)
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
  }
  return (email ?? '?').slice(0, 2).toUpperCase()
}
