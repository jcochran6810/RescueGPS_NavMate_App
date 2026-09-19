import { useEffect, useState } from 'react'
import { useWaypoints } from '@/store/useWaypoints'

/** Photos live in a private bucket, so each thumbnail needs a signed URL. */
export function WaypointPhoto({ path }: { path: string }) {
  const photoUrl = useWaypoints((s) => s.photoUrl)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    photoUrl(path).then((u) => {
      if (cancelled) return
      if (u) setUrl(u)
      else setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [path, photoUrl])

  if (failed) {
    /*
     * "offline" was said for every failure, and it hid a real one: a teammate
     * with full signal saw it on every photograph somebody else had taken,
     * because the storage read policy could never match a shared waypoint.
     * A signed-URL request for an object RLS hides comes back as an ordinary
     * not-found, so the app had no way to tell the two apart — but the
     * browser does know whether it has a connection, and saying which failure
     * this is would have pointed straight at the policy.
     */
    return (
      <div className="grid size-16 place-items-center rounded-lg border border-white/10 bg-navy-950 px-1 text-center text-[10px] text-slate-400">
        {navigator.onLine ? 'no access' : 'offline'}
      </div>
    )
  }

  if (!url) {
    return <div className="size-16 animate-pulse rounded-lg bg-white/5" />
  }

  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt="Waypoint photo"
        loading="lazy"
        className="size-16 rounded-lg border border-white/10 object-cover"
      />
    </a>
  )
}
