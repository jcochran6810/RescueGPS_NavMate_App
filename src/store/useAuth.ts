import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, errorMessage } from '@/lib/supabase'
import type { Profile } from '@/lib/types'

interface AuthState {
  session: Session | null
  user: User | null
  profile: Profile | null
  /** False until the initial session lookup has settled. */
  ready: boolean
  busy: boolean

  init: () => () => void
  signUp: (
    email: string,
    password: string,
    fullName: string,
    callsign: string,
  ) => Promise<{ error?: string; needsConfirmation?: boolean }>
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
  sendReset: (email: string) => Promise<{ error?: string }>
  loadProfile: () => Promise<void>
  updateProfile: (patch: Partial<Pick<Profile, 'full_name' | 'callsign'>>) =>
    Promise<{ error?: string }>
}

export const useAuth = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  ready: false,
  busy: false,

  init: () => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        set({
          session: data.session,
          user: data.session?.user ?? null,
          ready: true,
        })
        if (data.session) void get().loadProfile()
      })
      .catch(() => set({ ready: true }))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null, ready: true })
      if (session) void get().loadProfile()
      else set({ profile: null })
    })

    return () => sub.subscription.unsubscribe()
  },

  signUp: async (email, password, fullName, callsign) => {
    set({ busy: true })
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim(), callsign: callsign.trim() },
          emailRedirectTo: window.location.origin,
        },
      })
      if (error) return { error: errorMessage(error) }
      // No session means the project requires email confirmation first.
      return { needsConfirmation: !data.session }
    } finally {
      set({ busy: false })
    }
  },

  signIn: async (email, password) => {
    set({ busy: true })
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      return error ? { error: errorMessage(error) } : {}
    } finally {
      set({ busy: false })
    }
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ session: null, user: null, profile: null })
  },

  sendReset: async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    })
    return error ? { error: errorMessage(error) } : {}
  },

  loadProfile: async () => {
    const uid = get().user?.id ?? get().session?.user.id
    if (!uid) return
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', uid)
      .maybeSingle()
    if (!error && data) set({ profile: data as Profile })
  },

  updateProfile: async (patch) => {
    const uid = get().user?.id
    if (!uid) return { error: 'Not signed in' }
    const { data, error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', uid)
      .select()
      .single()
    if (error) return { error: errorMessage(error) }
    set({ profile: data as Profile })
    return {}
  },
}))
