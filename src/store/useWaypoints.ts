import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage, PHOTO_BUCKET } from '@/lib/supabase'
import type { NewWaypoint, Waypoint } from '@/lib/types'

/**
 * Waypoints are the one thing a crew cannot afford to lose signal over, so the
 * store keeps a local cache of the last server state plus a queue of writes
 * made while offline. The queue is flushed on reconnect and on every load.
 */
type PendingOp =
  | { kind: 'create'; waypoint: Waypoint }
  | { kind: 'update'; id: string; patch: Partial<Waypoint> }
  | { kind: 'delete'; id: string }

interface WaypointState {
  cache: Waypoint[]
  pending: PendingOp[]
  loading: boolean
  syncing: boolean
  lastSyncedAt: string | null
  /** Account the cache and queue belong to, so another sign-in on the same
   *  device cannot inherit them. */
  ownerId: string | null

  /** Cache merged with anything still queued — what the UI should render. */
  visible: () => Waypoint[]
  pendingCount: () => number

  load: () => Promise<void>
  flush: () => Promise<void>
  create: (input: NewWaypoint, photos?: File[]) => Promise<Waypoint | null>
  update: (id: string, patch: Partial<Waypoint>) => Promise<void>
  remove: (id: string) => Promise<void>
  importMany: (inputs: NewWaypoint[], teamId: string | null) => Promise<number>
  /** Attach photos to a waypoint that already exists. Needs a connection. */
  addPhotos: (id: string, files: File[]) => Promise<number>
  clearLocal: () => void
  photoUrl: (path: string) => Promise<string | null>
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  // Fallback for the rare browser without randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Last result of `merge`, keyed on the exact inputs that produced it.
 *
 * `visible()` is read as a Zustand selector, and React compares the value it
 * returns with Object.is between renders to detect a changed store. A fresh
 * array every call reads as "changed" forever: React re-renders, the selector
 * builds another new array, and the screen never paints. Returning the same
 * array until the cache or the queue actually changes is what makes the
 * derived list safe to select.
 */
let memo: { cache: Waypoint[]; pending: PendingOp[]; result: Waypoint[] } | null =
  null

/** Apply the queued ops on top of the cached server state. */
function merge(cache: Waypoint[], pending: PendingOp[]): Waypoint[] {
  if (memo && memo.cache === cache && memo.pending === pending) return memo.result
  const result = mergeUncached(cache, pending)
  memo = { cache, pending, result }
  return result
}

function mergeUncached(cache: Waypoint[], pending: PendingOp[]): Waypoint[] {
  const byId = new Map(cache.map((w) => [w.id, w]))
  for (const op of pending) {
    if (op.kind === 'create') byId.set(op.waypoint.id, op.waypoint)
    else if (op.kind === 'delete') byId.delete(op.id)
    else {
      const existing = byId.get(op.id)
      if (existing) byId.set(op.id, { ...existing, ...op.patch })
    }
  }
  return [...byId.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )
}

export const useWaypoints = create<WaypointState>()(
  persist(
    (set, get) => ({
      cache: [],
      pending: [],
      loading: false,
      syncing: false,
      lastSyncedAt: null,
      ownerId: null,

      visible: () => merge(get().cache, get().pending),
      pendingCount: () => get().pending.length,

      load: async () => {
        // getSession reads the locally stored session, so this works with no
        // signal — which is exactly when a stale cache would otherwise show.
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (uid) {
          if (get().ownerId && get().ownerId !== uid) get().clearLocal()
          set({ ownerId: uid })
        }

        if (!online()) return
        set({ loading: true })
        try {
          await get().flush()
          const { data, error } = await supabase
            .from('waypoints')
            .select('*')
            .order('created_at', { ascending: false })
          if (error) throw error
          set({
            cache: (data ?? []) as Waypoint[],
            lastSyncedAt: new Date().toISOString(),
          })
        } catch (e) {
          console.warn('waypoint load failed', errorMessage(e))
        } finally {
          set({ loading: false })
        }
      },

      flush: async () => {
        const queue = get().pending
        if (queue.length === 0 || !online() || get().syncing) return
        set({ syncing: true })

        let remaining: PendingOp[] = []
        try {
          for (let i = 0; i < queue.length; i++) {
            const op = queue[i]
            try {
              if (op.kind === 'create') {
                const { id, user_id, team_id, name, lat, lon, note, photos, created_at } =
                  op.waypoint
                const { error } = await supabase
                  .from('waypoints')
                  .upsert(
                    { id, user_id, team_id, name, lat, lon, note, photos, created_at },
                    { onConflict: 'id' },
                  )
                if (error) throw error
              } else if (op.kind === 'update') {
                const { error } = await supabase
                  .from('waypoints')
                  .update(op.patch)
                  .eq('id', op.id)
                if (error) throw error
              } else {
                const { error } = await supabase
                  .from('waypoints')
                  .delete()
                  .eq('id', op.id)
                if (error) throw error
              }
            } catch (e) {
              // Keep this op queued and stop — order matters between ops on the
              // same row, so later ops must not run past a failure.
              console.warn('sync failed, keeping queued', errorMessage(e))
              remaining = queue.slice(i)
              break
            }
          }
        } finally {
          set({ pending: remaining, syncing: false })
        }
      },

      create: async (input, photos = []) => {
        // getSession reads the stored session; getUser asks the server. This
        // used to ask the server, which meant creating a waypoint failed
        // outright with no signal — the one situation the offline queue below
        // exists for. Nothing was queued, because the function returned before
        // it got that far.
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return null

        const id = newId()
        const now = new Date().toISOString()
        let photoPaths: string[] = []

        if (photos.length > 0 && online()) {
          photoPaths = await uploadPhotos(uid, id, photos)
        }

        const waypoint: Waypoint = {
          id,
          user_id: uid,
          team_id: input.team_id ?? null,
          name: input.name.trim() || 'Waypoint',
          lat: input.lat,
          lon: input.lon,
          note: input.note ?? '',
          photos: photoPaths,
          created_at: now,
          updated_at: now,
        }

        set({
          ownerId: uid,
          pending: [...get().pending, { kind: 'create', waypoint }],
        })
        await get().flush()
        return waypoint
      },

      update: async (id, patch) => {
        set({
          pending: [
            ...get().pending,
            {
              kind: 'update',
              id,
              patch: { ...patch, updated_at: new Date().toISOString() },
            },
          ],
        })
        await get().flush()
      },

      remove: async (id) => {
        set({ pending: [...get().pending, { kind: 'delete', id }] })
        await get().flush()
      },

      importMany: async (inputs, teamId) => {
        let n = 0
        for (const input of inputs) {
          const created = await get().create({ ...input, team_id: teamId })
          if (created) n += 1
        }
        return n
      },

      /**
       * Photos are uploaded to Storage before the row is patched, so a failed
       * upload leaves the waypoint exactly as it was rather than pointing at
       * an object that is not there.
       *
       * The upload goes under the *uploader's* folder even on a teammate's
       * waypoint — that is what the storage policy allows — and the read
       * policy still lets the rest of the team see it, because it matches on
       * the waypoint id in the second path segment.
       */
      addPhotos: async (id, files) => {
        if (files.length === 0) return 0
        if (!online()) throw new Error('Photos need a connection to upload')

        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) throw new Error('Sign in again to add photos')

        const waypoint = get().visible().find((w) => w.id === id)
        if (!waypoint) throw new Error('That waypoint is no longer there')

        const room = Math.max(0, 8 - waypoint.photos.length)
        if (room === 0) throw new Error('That waypoint already has 8 photos')

        const uploaded = await uploadPhotos(uid, id, files.slice(0, room))
        if (uploaded.length === 0) throw new Error('Photo upload failed')

        await get().update(id, { photos: [...waypoint.photos, ...uploaded] })
        return uploaded.length
      },

      clearLocal: () =>
        set({ cache: [], pending: [], lastSyncedAt: null, ownerId: null }),

      photoUrl: async (path) => {
        const { data, error } = await supabase.storage
          .from(PHOTO_BUCKET)
          .createSignedUrl(path, 60 * 60)
        return error ? null : data.signedUrl
      },
    }),
    {
      name: 'navmate.waypoints.v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        cache: s.cache,
        pending: s.pending,
        lastSyncedAt: s.lastSyncedAt,
        ownerId: s.ownerId,
      }),
    },
  ),
)

async function uploadPhotos(
  userId: string,
  waypointId: string,
  files: File[],
): Promise<string[]> {
  const paths: string[] = []
  for (const file of files.slice(0, 8)) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5)
    const path = `${userId}/${waypointId}/${newId()}.${ext}`
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, file, { contentType: file.type || 'image/jpeg' })
    if (!error) paths.push(path)
    else console.warn('photo upload failed', errorMessage(error))
  }
  return paths
}
