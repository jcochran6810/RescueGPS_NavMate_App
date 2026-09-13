/**
 * NavMate moved from `rescuegps.stationinsight.com` to
 * `navmate.stationinsight.com`, and the old address now serves the RescueGPS
 * command system instead.
 *
 * This matters more than a redirect would fix. An installed PWA is bound to
 * the origin it was installed from, so a copy installed at the old address
 * keeps its own cached waypoints, queued writes and saved chart tiles, and
 * none of it follows to the new one. Reinstalling is the only way across, and
 * anything stamped but not yet synced does not make the trip.
 *
 * Shown only on the address that is actually moving. That makes it
 * self-retiring — it disappears the moment somebody reinstalls — and keeps it
 * out of development, preview deployments and the new address entirely.
 */

const OLD_HOST = 'rescuegps.stationinsight.com'
const NEW_HOST = 'navmate.stationinsight.com'

export function MovedNotice() {
  if (typeof window === 'undefined') return null
  if (window.location.hostname !== OLD_HOST) return null

  return (
    <div
      role="status"
      className="border-b border-amber-400/30 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-100"
    >
      <strong className="font-semibold">NavMate has moved.</strong> Install it
      again from{' '}
      <a
        href={`https://${NEW_HOST}`}
        className="font-semibold underline underline-offset-2 hover:text-amber-50"
      >
        {NEW_HOST}
      </a>
      , then delete this one — this address is becoming the RescueGPS command
      system. Anything stamped here that has not synced yet stays here.
    </div>
  )
}
