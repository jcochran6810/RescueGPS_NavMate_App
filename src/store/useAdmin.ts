import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { retrying, describeError } from '@/lib/retry'
import type {
  AdminAction,
  AdminMetrics,
  AdminUser,
  RequestStatus,
  SupportRequest,
} from '@/lib/types'

/**
 * The platform admin dashboard's data.
 *
 * Deliberately online-only, unlike everything else in this app: the dashboard
 * is a desk tool, not a field tool, and stale metrics presented as live would
 * mislead in exactly the way the offline-first stores exist to prevent. A
 * failed load keeps what it has and says why.
 *
 * Every read is plain RLS-gated selects or admin RPCs; every mutation is a
 * SECURITY DEFINER RPC that writes its own audit row. The client never holds
 * anything more privileged than the user's own JWT.
 */

interface AdminState {
  /** null = not yet checked; the tab stays hidden until this is true. */
  isAdmin: boolean | null
  metrics: AdminMetrics | null
  users: AdminUser[]
  requests: SupportRequest[]
  /** Email/name lookup for request authors, from the users list. */
  actions: AdminAction[]
  loading: boolean
  error: string | null

  /** Cheap self-check on sign-in; decides whether the Admin tab shows. */
  check: () => Promise<void>
  /** Load or reload everything the dashboard shows. */
  refresh: () => Promise<void>
  updateRequest: (
    id: string,
    status: RequestStatus,
    adminNotes: string,
  ) => Promise<{ error?: string }>
  updateProfile: (
    userId: string,
    fullName: string,
    callsign: string,
  ) => Promise<{ error?: string }>
  reset: () => void
}

export const useAdmin = create<AdminState>((set, get) => ({
  isAdmin: null,
  metrics: null,
  users: [],
  requests: [],
  actions: [],
  loading: false,
  error: null,

  check: async () => {
    const uid = (await supabase.auth.getSession()).data.session?.user?.id
    if (!uid) {
      set({ isAdmin: false })
      return
    }
    // Self-read policy makes this a one-row lookup, no RPC round trip.
    const { data, error } = await supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', uid)
      .maybeSingle()
    set({ isAdmin: !error && data != null })
  },

  refresh: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const [metrics, users, requests, actions] = await Promise.all([
        retrying(() => supabase.rpc('admin_metrics')),
        retrying(() => supabase.rpc('admin_list_users')),
        retrying(() =>
          supabase
            .from('support_requests')
            .select('*')
            .order('created_at', { ascending: false }),
        ),
        retrying(() =>
          supabase
            .from('admin_actions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(25),
        ),
      ])

      const failed = [metrics, users, requests, actions].find((r) => r.error)
      if (failed) throw failed.error

      set({
        metrics: metrics.data as AdminMetrics,
        users: (users.data ?? []) as AdminUser[],
        requests: (requests.data ?? []) as SupportRequest[],
        actions: (actions.data ?? []) as AdminAction[],
        error: null,
      })
    } catch (e) {
      // Keep whatever loaded last time; say why it may be stale.
      set({ error: describeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  updateRequest: async (id, status, adminNotes) => {
    const { error } = await retrying(() =>
      supabase.rpc('admin_update_request', {
        p_id: id,
        p_status: status,
        p_admin_notes: adminNotes,
      }),
    )
    if (error) return { error: describeError(error) }
    await get().refresh()
    return {}
  },

  updateProfile: async (userId, fullName, callsign) => {
    const { error } = await retrying(() =>
      supabase.rpc('admin_update_profile', {
        p_user_id: userId,
        p_full_name: fullName,
        p_callsign: callsign,
      }),
    )
    if (error) return { error: describeError(error) }
    await get().refresh()
    return {}
  },

  reset: () =>
    set({
      isAdmin: null,
      metrics: null,
      users: [],
      requests: [],
      actions: [],
      error: null,
    }),
}))
