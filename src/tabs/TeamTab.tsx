import { useEffect, useState } from 'react'
import { useTeams } from '@/store/useTeams'
import { useAuth } from '@/store/useAuth'
import { toast } from '@/store/useToast'
import { Button, Card, EmptyState, Input, Label } from '@/components/ui'
import type { TeamRole } from '@/lib/types'

const ROLE_LABEL: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
}

export function TeamTab() {
  const {
    teams,
    members,
    activeTeamId,
    activeTeam,
    error,
    load,
    createTeam,
    joinTeam,
    leaveTeam,
    rotateCode,
    setRole,
    removeMember,
  } = useTeams()
  const { user } = useAuth()

  const [newName, setNewName] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const team = activeTeam()
  const myRole = members.find((m) => m.user_id === user?.id)?.role ?? null
  const isAdmin = myRole === 'owner' || myRole === 'admin'

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Team</h2>
        <p className="text-sm text-slate-400">
          Share waypoints with the people working the same incident.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
          <p>{error}</p>
          <button
            onClick={() => void load()}
            className="mt-1.5 rounded-lg border border-amber-400/30 px-2.5 py-1 text-xs hover:bg-amber-500/10"
          >
            Try again
          </button>
        </div>
      )}

      {team ? (
        <Card>
          <div className="flex items-start justify-between gap-2">
            <div>
              <Label>Current team</Label>
              <div className="text-lg font-semibold text-slate-50">
                {team.name}
              </div>
            </div>
            <span className="rounded-full bg-white/5 px-2 py-1 text-xs text-slate-300">
              {myRole ? ROLE_LABEL[myRole] : ''}
            </span>
          </div>

          <div className="mt-3">
            <Label>Join code</Label>
            <div className="flex items-center gap-2">
              <code className="tnum flex-1 rounded-lg border border-white/10 bg-navy-950/60 px-3 py-2.5 text-lg font-semibold tracking-[0.3em] text-sky-300">
                {team.join_code}
              </code>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(team.join_code)
                    toast('Join code copied', 'success')
                  } catch {
                    toast(team.join_code)
                  }
                }}
              >
                Copy
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Anyone with this code can join and see the team's waypoints.
              {isAdmin && ' Rotate it if it gets out.'}
            </p>
            {isAdmin && (
              <Button
                variant="ghost"
                className="mt-2"
                onClick={async () => {
                  if (!confirm('Rotate the join code? The old one stops working.'))
                    return
                  const { error } = await rotateCode(team.id)
                  toast(error ?? 'New join code issued', error ? 'error' : 'success')
                }}
              >
                Rotate code
              </Button>
            )}
          </div>

          <div className="mt-4">
            <Label>Members ({members.length})</Label>
            <ul className="space-y-1.5">
              {members.map((m) => {
                const label =
                  m.profile?.callsign ||
                  m.profile?.full_name ||
                  m.profile?.email ||
                  'Member'
                const isMe = m.user_id === user?.id
                return (
                  <li
                    key={m.user_id}
                    className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-100">
                        {label}
                        {isMe && (
                          <span className="ml-1.5 text-xs text-slate-500">
                            (you)
                          </span>
                        )}
                      </div>
                      {m.profile?.full_name && m.profile.callsign && (
                        <div className="truncate text-xs text-slate-500">
                          {m.profile.full_name}
                        </div>
                      )}
                    </div>

                    {isAdmin && !isMe ? (
                      <select
                        value={m.role}
                        onChange={async (e) => {
                          const { error } = await setRole(
                            team.id,
                            m.user_id,
                            e.target.value as TeamRole,
                          )
                          if (error) toast(error, 'error')
                        }}
                        className="rounded-lg border border-white/10 bg-navy-900 px-1.5 py-1 text-xs text-slate-200"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                        <option value="owner">Owner</option>
                      </select>
                    ) : (
                      <span className="text-xs text-slate-400">
                        {ROLE_LABEL[m.role]}
                      </span>
                    )}

                    {isAdmin && !isMe && (
                      <button
                        onClick={async () => {
                          if (!confirm(`Remove ${label} from ${team.name}?`)) return
                          const { error } = await removeMember(team.id, m.user_id)
                          toast(error ?? 'Member removed', error ? 'error' : 'info')
                        }}
                        className="rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          <Button
            variant="ghost"
            className="mt-4 w-full"
            onClick={async () => {
              if (!confirm(`Leave ${team.name}? You will lose access to its waypoints.`))
                return
              const { error } = await leaveTeam(team.id)
              toast(error ?? `Left ${team.name}`, error ? 'error' : 'info')
            }}
          >
            Leave team
          </Button>
        </Card>
      ) : (
        <EmptyState>
          {error
            ? 'Could not load your teams, so this list may be incomplete.'
            : teams.length === 0
              ? 'You are not on a team yet. Create one or join with a code.'
              : 'Pick a team in the bar above to manage it.'}
        </EmptyState>
      )}

      <Card>
        <Label>Create a team</Label>
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Hillsborough SAR"
            maxLength={80}
          />
          <Button
            variant="primary"
            onClick={async () => {
              if (!newName.trim()) return toast('Enter a team name', 'error')
              const { error } = await createTeam(newName)
              if (error) return toast(error, 'error')
              setNewName('')
              toast('Team created', 'success')
            }}
          >
            Create
          </Button>
        </div>
      </Card>

      <Card>
        <Label>Join a team</Label>
        <div className="flex gap-2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="6-character code"
            maxLength={6}
            autoCapitalize="characters"
            className="tnum tracking-[0.3em] uppercase"
          />
          <Button
            onClick={async () => {
              if (!code.trim()) return toast('Enter a join code', 'error')
              const { error } = await joinTeam(code)
              if (error) return toast(error, 'error')
              setCode('')
              toast('Joined team', 'success')
            }}
          >
            Join
          </Button>
        </div>
      </Card>

      {activeTeamId === null && teams.length > 0 && (
        <p className="text-center text-xs text-slate-500">
          You are in “Private” scope — new waypoints stay on your account only.
        </p>
      )}
    </div>
  )
}
