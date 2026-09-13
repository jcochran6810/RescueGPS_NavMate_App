import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { retrying, describeError } from '@/lib/retry'
import type { Team, TeamMember, TeamRole } from '@/lib/types'

const ACTIVE_TEAM_KEY = 'navmate.activeTeamId'

interface TeamState {
  teams: Team[]
  members: TeamMember[]
  /** null = "Private", i.e. waypoints visible only to this account. */
  activeTeamId: string | null
  loading: boolean
  /**
   * Why the last load failed, or null. Without this the page cannot tell
   * "you are on no teams" apart from "we could not find out", and it was
   * confidently saying the first when the second was true.
   */
  error: string | null

  activeTeam: () => Team | null
  myRole: (userId: string | undefined) => TeamRole | null

  load: () => Promise<void>
  loadMembers: (teamId: string) => Promise<void>
  setActiveTeam: (teamId: string | null) => void
  createTeam: (name: string) => Promise<{ team?: Team; error?: string }>
  joinTeam: (code: string) => Promise<{ team?: Team; error?: string }>
  leaveTeam: (teamId: string) => Promise<{ error?: string }>
  rotateCode: (teamId: string) => Promise<{ code?: string; error?: string }>
  setRole: (teamId: string, userId: string, role: TeamRole) =>
    Promise<{ error?: string }>
  removeMember: (teamId: string, userId: string) => Promise<{ error?: string }>
  reset: () => void
}

export const useTeams = create<TeamState>((set, get) => ({
  teams: [],
  members: [],
  activeTeamId: localStorage.getItem(ACTIVE_TEAM_KEY) || null,
  loading: false,
  error: null,

  activeTeam: () => get().teams.find((t) => t.id === get().activeTeamId) ?? null,

  myRole: (userId) => {
    if (!userId) return null
    const m = get().members.find(
      (x) => x.user_id === userId && x.team_id === get().activeTeamId,
    )
    return m?.role ?? null
  },

  load: async () => {
    set({ loading: true })
    try {
      const { data, error } = await retrying(() =>
        supabase
          .from('teams')
          .select('*')
          .order('created_at', { ascending: true }),
      )
      if (error) throw error

      const teams = (data ?? []) as Team[]
      // Drop a stale selection, e.g. after leaving a team on another device.
      const active = teams.some((t) => t.id === get().activeTeamId)
        ? get().activeTeamId
        : null
      set({ teams, activeTeamId: active, error: null })
      if (!active) localStorage.removeItem(ACTIVE_TEAM_KEY)
      if (active) await get().loadMembers(active)
    } catch (e) {
      // Keep whatever was already loaded and say why it may be out of date,
      // rather than silently presenting an empty list as the truth.
      set({ error: describeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  loadMembers: async (teamId) => {
    const { data, error } = await retrying(() =>
      supabase
        .from('team_members')
        .select('*')
        .eq('team_id', teamId)
        .order('joined_at', { ascending: true }),
    )
    if (error) return
    const rows = (data ?? []) as TeamMember[]

    // Names come from an RPC rather than a PostgREST embed on `profiles`.
    // That table is shared with the RescueGPS command system and carries push
    // tokens, emergency contacts and clearance levels; RLS is row-level, so a
    // policy letting a crew read a teammate's name would hand over all of it.
    // navmate_team_profiles() returns three columns and nothing else.
    const { data: people } = await retrying(() =>
      supabase.rpc('navmate_team_profiles', { p_team_id: teamId }),
    )
    const byId = new Map(
      ((people ?? []) as { id: string; full_name: string; call_sign: string }[])
        .map((p) => [p.id, p]),
    )
    set({
      members: rows.map((m) => {
        const p = byId.get(m.user_id)
        return p
          ? {
              ...m,
              profile: {
                id: p.id,
                email: null,
                full_name: p.full_name,
                call_sign: p.call_sign,
                created_at: '',
                updated_at: '',
              },
            }
          : m
      }),
    })
  },

  setActiveTeam: (teamId) => {
    set({ activeTeamId: teamId, members: [] })
    if (teamId) {
      localStorage.setItem(ACTIVE_TEAM_KEY, teamId)
      void get().loadMembers(teamId)
    } else {
      localStorage.removeItem(ACTIVE_TEAM_KEY)
    }
  },

  createTeam: async (name) => {
    // A project that has been idle answers the first request with PGRST002
    // while its database wakes. Creating a team is often the very first write
    // an account ever makes, so it is the single most likely place to meet it.
    const { data, error } = await retrying(() =>
      supabase.rpc('create_team', { p_name: name }),
    )
    if (error) return { error: describeError(error) }
    const team = data as Team
    await get().load()
    get().setActiveTeam(team.id)
    return { team }
  },

  joinTeam: async (code) => {
    const { data, error } = await retrying(() =>
      supabase.rpc('join_team', { p_code: code }),
    )
    if (error) return { error: describeError(error) }
    const team = data as Team
    await get().load()
    get().setActiveTeam(team.id)
    return { team }
  },

  leaveTeam: async (teamId) => {
    const uid = (await supabase.auth.getUser()).data.user?.id
    if (!uid) return { error: 'Not signed in' }
    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', uid)
    if (error) return { error: describeError(error) }
    get().setActiveTeam(null)
    await get().load()
    return {}
  },

  rotateCode: async (teamId) => {
    const { data, error } = await supabase.rpc('rotate_join_code', {
      p_team_id: teamId,
    })
    if (error) return { error: describeError(error) }
    await get().load()
    return { code: data as string }
  },

  setRole: async (teamId, userId, role) => {
    const { error } = await supabase
      .from('team_members')
      .update({ role })
      .eq('team_id', teamId)
      .eq('user_id', userId)
    if (error) return { error: describeError(error) }
    await get().loadMembers(teamId)
    return {}
  },

  removeMember: async (teamId, userId) => {
    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', userId)
    if (error) return { error: describeError(error) }
    await get().loadMembers(teamId)
    return {}
  },

  reset: () => set({ teams: [], members: [], activeTeamId: null, error: null }),
}))
