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
    return (
      <div className="grid size-16 place-items-center rounded-lg border border-white/10 bg-navy-950 text-[10px] text-slate-500">
        offline
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
