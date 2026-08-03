import { createClient } from '@supabase/supabase-js'

// NavMate talks to exactly one Supabase project, and both of these values are
// publishable — row level security is the boundary, not secrecy. Baking them in
// means a fresh clone or a fresh Vercel project runs with no configuration at
// all, and removes the blank-screen failure of a missing env var. Set the env
// vars to point a build somewhere else (a fork, a staging project).
const DEFAULT_URL = 'https://puzwcsrtqtbutypzozvu.supabase.co'
const DEFAULT_KEY = 'sb_publishable_epPlnaBqhZw7GAFxYcCxag_PqOh77-0'

const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

export const PHOTO_BUCKET = 'waypoint-photos'

/** Turn a PostgREST/GoTrue error into something worth showing a user. */
export function errorMessage(error: unknown): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  const maybe = error as { message?: string; error_description?: string }
  return maybe.message ?? maybe.error_description ?? 'Unknown error'
}
