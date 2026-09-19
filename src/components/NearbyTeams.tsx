import { useEffect, useState } from 'react'
import { Button, Input, Label } from '@/components/ui'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { supabase, errorMessage } from '@/lib/supabase'
import { toast } from '@/store/useToast'

/** A team working nearby, as `navmate_teams_near()` describes it. */
interface NearbyTeam {
  id: string
  name: string
  members: number
  distance_nm: number
  last_active: string
  joined: boolean
}

/** How far out to look. The crew asked for ten miles. */
const RADIUS_NM = 10

/**
 * Teams working near here.
 *
 * The hard part of a join code has never been typing it — it is knowing which
 * team you are being invited to when three departments are on the same water,
 * and a code typed into the wrong one puts a crew's waypoints somewhere they
 * did not mean.
 *
 * So this narrows it down and then **still asks for the code**. Picking a team
 * from the list is not joining it: the list is confirmation that the code is
 * going where the crew thinks it is. Nothing here returns a join code, and
 * nothing here returns a position — only a range — so knowing a team is out
 * there gets you no further than looking out of the window does.
 */
export function NearbyTeams() {
  const joinTeam = useTeams((s) => s.joinTeam)
  const fix = useTracker((s) => s.fix)
  const once = useTracker((s) => s.once)

  const [teams, setTeams] = useState<NearbyTeam[] | null>(null)
  const [looking, setLooking] = useState(false)
  const [selected, setSelected] = useState<NearbyTeam | null>(null)
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!fix) return
    let live = true
    void (async () => {
      const { data, error } = await supabase.rpc('navmate_teams_near', {
        p_lat: fix.lat,
        p_lon: fix.lon,
        p_radius_nm: RADIUS_NM,
      })
      if (!live) return
      if (error) {
        console.warn('nearby teams failed', errorMessage(error))
        setTeams([])
        return
      }
      setTeams((data ?? []) as NearbyTeam[])
    })()
    return () => {
      live = false
    }
    // Only on the first fix and on a real move: this is a list of departments,
    // not a live display, and re-querying on every GPS update would ask the
    // database a question a second whose answer changes by the week.
  }, [fix?.lat?.toFixed(2), fix?.lon?.toFixed(2)])

  if (!fix) {
    return (
      <div className="mt-3">
        <Label>Teams near you</Label>
        <Button
          variant="ghost"
          className="w-full"
          disabled={looking}
          onClick={async () => {
            setLooking(true)
            const got = await once()
            setLooking(false)
            if (!got) toast(useTracker.getState().error ?? 'No fix yet', 'error')
          }}
        >
          {looking ? 'Taking a fix…' : 'Find teams within 10 miles'}
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-3">
      <Label>Teams near you</Label>
      {teams === null && <p className="text-sm text-slate-300">Looking…</p>}
      {teams !== null && teams.length === 0 && (
        <p className="text-xs text-slate-400">
          No teams have logged anything within {RADIUS_NM} miles in the last
          month. Ask for the six-character code and enter it above.
        </p>
      )}

      <ul className="space-y-1.5">
        {teams?.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              disabled={t.joined}
              aria-pressed={selected?.id === t.id}
              onClick={() => {
                setSelected(selected?.id === t.id ? null : t)
                setCode('')
              }}
              className={
                'w-full rounded-xl border px-3 py-2 text-left disabled:opacity-50 ' +
                (selected?.id === t.id
                  ? 'border-sky-400/60 bg-sky-500/10'
                  : 'border-white/10 hover:bg-white/5')
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-slate-50">{t.name}</span>
                <span className="tnum shrink-0 text-xs text-slate-300">
                  {t.distance_nm.toFixed(1)} NM
                </span>
              </div>
              <div className="text-xs text-slate-400">
                {t.members} member{t.members === 1 ? '' : 's'}
                {t.joined ? ' · you are on this team' : ''}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {selected && !selected.joined && (
        <div className="mt-2 flex gap-2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="6-character code"
            aria-label={`Join code for ${selected.name}`}
            maxLength={6}
            autoCapitalize="characters"
            className="tnum tracking-[0.3em] uppercase"
          />
          <Button
            variant="primary"
            onClick={async () => {
              if (!code.trim()) return toast('Enter the join code', 'error')
              const { error } = await joinTeam(code)
              if (error) return toast(error, 'error')
              setCode('')
              setSelected(null)
              toast(`Joined ${selected.name}`, 'success')
            }}
          >
            Join
          </Button>
        </div>
      )}
      {selected && !selected.joined && (
        <p className="mt-1 text-[11px] text-slate-400">
          Choosing a team does not join it — the code still has to be right.
        </p>
      )}
    </div>
  )
}
