import { create } from 'zustand'
import { supabase, errorMessage } from '@/lib/supabase'
import type { Team, TeamMember, TeamRole } from '@/lib/types'

const ACTIVE_TEAM_KEY = 'navmate.activeTeamId'

interface TeamState {
  teams: Team[]
  members: TeamMember[]
  /** null = "Private", i.e. waypoints visible only to this account. */
  activeTeamId: string | null
  loading: boolean

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
      const { data, error } = await supabase
        .from('teams')
        .select('*')
        .order('created_at', { ascending: true })
      if (error) throw error

      const teams = (data ?? []) as Team[]
      // Drop a stale selection, e.g. after leaving a team on another device.
      const active = teams.some((t) => t.id === get().activeTeamId)
        ? get().activeTeamId
        : null
      set({ teams, activeTeamId: active })
      if (!active) localStorage.removeItem(ACTIVE_TEAM_KEY)
      if (active) await get().loadMembers(active)
    } catch (e) {
      console.warn('team load failed', errorMessage(e))
    } finally {
      set({ loading: false })
    }
  },

  loadMembers: async (teamId) => {
    const { data, error } = await supabase
      .from('team_members')
      .select('*, profile:profiles!team_members_user_id_profiles_fkey(*)')
      .eq('team_id', teamId)
      .order('joined_at', { ascending: true })
    if (!error) set({ members: (data ?? []) as TeamMember[] })
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
    const { data, error } = await supabase.rpc('create_team', { p_name: name })
    if (error) return { error: errorMessage(error) }
    const team = data as Team
    await get().load()
    get().setActiveTeam(team.id)
    return { team }
  },

  joinTeam: async (code) => {
    const { data, error } = await supabase.rpc('join_team', { p_code: code })
    if (error) return { error: errorMessage(error) }
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
    if (error) return { error: errorMessage(error) }
    get().setActiveTeam(null)
    await get().load()
    return {}
  },

  rotateCode: async (teamId) => {
    const { data, error } = await supabase.rpc('rotate_join_code', {
      p_team_id: teamId,
    })
    if (error) return { error: errorMessage(error) }
    await get().load()
    return { code: data as string }
  },

  setRole: async (teamId, userId, role) => {
    const { error } = await supabase
      .from('team_members')
      .update({ role })
      .eq('team_id', teamId)
      .eq('user_id', userId)
    if (error) return { error: errorMessage(error) }
    await get().loadMembers(teamId)
    return {}
  },

  removeMember: async (teamId, userId) => {
    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', userId)
    if (error) return { error: errorMessage(error) }
    await get().loadMembers(teamId)
    return {}
  },

  reset: () => set({ teams: [], members: [], activeTeamId: null }),
}))
