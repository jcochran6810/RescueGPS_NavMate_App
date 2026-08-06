import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { retrying, describeError } from '@/lib/retry'
import type { RequestKind, SupportRequest } from '@/lib/types'

/**
 * The user's side of support requests: file one, see what happened to it.
 *
 * Online-only by design — a request to the platform admin is a conversation
 * with a person, not field data, and pretending one was "sent" while offline
 * would be the dishonest kind of optimism. The form says so when offline.
 */
interface SupportState {
  mine: SupportRequest[]
  loading: boolean
  error: string | null

  load: () => Promise<void>
  submit: (
    kind: RequestKind,
    subject: string,
    body: string,
  ) => Promise<{ error?: string }>
  reset: () => void
}

export const useSupport = create<SupportState>((set, get) => ({
  mine: [],
  loading: false,
  error: null,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const { data, error } = await retrying(() =>
        supabase
          .from('support_requests')
          .select('*')
          .order('created_at', { ascending: false }),
      )
      if (error) throw error
      set({ mine: (data ?? []) as SupportRequest[], error: null })
    } catch (e) {
      set({ error: describeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  submit: async (kind, subject, body) => {
    const uid = (await supabase.auth.getSession()).data.session?.user?.id
    if (!uid) return { error: 'Sign in again to send a request' }
    const { error } = await retrying(() =>
      supabase.from('support_requests').insert({
        user_id: uid,
        kind,
        subject: subject.trim(),
        body: body.trim(),
      }),
    )
    if (error) return { error: describeError(error) }
    await get().load()
    return {}
  },

  reset: () => set({ mine: [], error: null }),
}))
