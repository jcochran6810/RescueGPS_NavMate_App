import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage, PHOTO_BUCKET } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import type { NewWaypoint, Waypoint } from '@/lib/types'

/**
 * Waypoints are the one thing a crew cannot afford to lose signal over, so the
 * store keeps a local cache of the last server state plus a queue of writes
 * made while offline. The queue is flushed on reconnect and on every load.
 */
export type PendingOp = (
  | { kind: 'create'; waypoint: Waypoint }
  | {
      kind: 'update'
      id: string
      patch: Partial<Waypoint>
    }
  | {
      kind: 'delete'
      id: string
      /** Own-folder photo paths captured at delete time, so the objects can be
       *  removed from Storage once the row is gone. */
      photoPaths?: string[]
    }
) & {
  /** Times the server has definitively refused this op. */
  attempts?: number
}

/** An op the server has refused enough times that retrying it is pointless.
 *  Kept visible rather than silently dropped — the crew decides. */
export interface FailedOp {
  op: PendingOp
  reason: string
  failedAt: string
}

/** Definitive server refusals tolerated before an op is set aside. Covers a
 *  misclassified transient without letting one bad op block the queue forever. */
const MAX_ATTEMPTS = 3

interface WaypointState {
  cache: Waypoint[]
  pending: PendingOp[]
  /** Ops the server refused repeatedly. They no longer block the queue. */
  failed: FailedOp[]
  loading: boolean
  syncing: boolean
  lastSyncedAt: string | null
  /** Account the cache and queue belong to, so another sign-in on the same
   *  device cannot inherit them. */
  ownerId: string | null
  /** Waypoint id -> number of photos held in memory awaiting a connection. */
  stagedPhotoCount: Record<string, number>

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
  /** Hold photos in memory for a waypoint until a connection comes back.
   *  Memory only — they do not survive an app reload, and the UI says so. */
  stagePhotos: (id: string, files: File[]) => void
  stagedFor: (id: string) => File[]
  /** Upload everything staged. Called on reconnect. Returns photos uploaded. */
  drainStagedPhotos: () => Promise<number>
  /** Put the failed ops back at the head of the queue for another try. */
  retryFailed: () => Promise<void>
  discardFailed: () => void
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
let memo: {
  cache: Waypoint[]
  failed: FailedOp[]
  pending: PendingOp[]
  result: Waypoint[]
} | null = null

/**
 * Apply the queued ops on top of the cached server state.
 *
 * Failed ops are layered in too, ahead of the live queue: an op the server
 * refused is still the crew's local data, and a waypoint disappearing from
 * the screen because sync failed would read as data loss. It stays visible
 * until the crew explicitly discards it from the Data tab.
 */
function merge(
  cache: Waypoint[],
  failed: FailedOp[],
  pending: PendingOp[],
): Waypoint[] {
  if (
    memo &&
    memo.cache === cache &&
    memo.failed === failed &&
    memo.pending === pending
  ) {
    return memo.result
  }
  const result = mergeUncached(cache, [...failed.map((f) => f.op), ...pending])
  memo = { cache, failed, pending, result }
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

/**
 * A server answer that will not change on retry: not "no signal", not "the
 * database is waking up", but an actual refusal — RLS, a bad row, a constraint.
 */
function isTerminal(e: unknown): boolean {
  return !isOffline(e) && !isTransient(e)
}

/** Bumped whenever a flush lands at least one op, so a concurrent `load` can
 *  tell its server snapshot may already be stale. */
let flushSeq = 0

/** Photos held in memory for waypoints stamped without signal. Deliberately
 *  not persisted: localStorage is not sized for image bytes (fix_list has the
 *  IndexedDB item), so the promise the UI makes is "keep the app open". */
const stagedFiles = new Map<string, File[]>()

function stagedCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, files] of stagedFiles) out[id] = files.length
  return out
}

export const useWaypoints = create<WaypointState>()(
  persist(
    (set, get) => ({
      cache: [],
      pending: [],
      failed: [],
      loading: false,
      syncing: false,
      lastSyncedAt: null,
      ownerId: null,
      stagedPhotoCount: {},

      visible: () => merge(get().cache, get().failed, get().pending),
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
        if (get().loading) return
        set({ loading: true })
        try {
          await get().flush()
          // If a flush lands while the select is in flight, the snapshot can
          // predate ops that are no longer in the queue — a waypoint would
          // blink out of the list until the next load. Detect that and fetch
          // once more.
          for (let attempt = 0; attempt < 2; attempt++) {
            const seqBefore = flushSeq
            const { data, error } = await supabase
              .from('waypoints')
              .select('*')
              .order('created_at', { ascending: false })
            if (error) throw error
            set({
              cache: (data ?? []) as Waypoint[],
              lastSyncedAt: new Date().toISOString(),
            })
            if (flushSeq === seqBefore) break
          }
        } catch (e) {
          console.warn('waypoint load failed', errorMessage(e))
        } finally {
          set({ loading: false })
        }
      },

      flush: async () => {
        const queue = get().pending
        if (queue.length === 0 || !online() || get().syncing) return

        // Never replay a queue under a different account's session: an op
        // written as user A would be refused (or worse, misattributed) sent
        // with user B's JWT. The queue stays put until A signs back in.
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const owner = get().ownerId
        if (!uid || (owner !== null && owner !== uid)) return

        set({ syncing: true })

        let remaining: PendingOp[] = []
        const newlyFailed: FailedOp[] = []
        let progressed = false
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
                // The row is gone; clear out its photo objects. Best-effort —
                // the storage policy only lets us remove our own uploads, and
                // an orphaned object is a nuisance, not a data loss.
                if (op.photoPaths && op.photoPaths.length > 0) {
                  await supabase.storage
                    .from(PHOTO_BUCKET)
                    .remove(op.photoPaths)
                    .then(
                      () => undefined,
                      () => undefined,
                    )
                }
              }
              progressed = true
            } catch (e) {
              if (isTerminal(e)) {
                // A refusal, not an outage. Retry a bounded number of times —
                // then set the op aside so it stops blocking everything behind
                // it, and keep going.
                const attempts = (op.attempts ?? 0) + 1
                if (attempts >= MAX_ATTEMPTS) {
                  console.warn('op failed permanently', errorMessage(e))
                  newlyFailed.push({
                    op,
                    reason: describeError(e),
                    failedAt: new Date().toISOString(),
                  })
                  continue
                }
                remaining = [
                  { ...op, attempts },
                  ...queue.slice(i + 1),
                ]
              } else {
                // No signal or a server that is coming back — keep this op
                // queued and stop. Order matters between ops on the same row,
                // so later ops must not run past a failure.
                console.warn('sync failed, keeping queued', errorMessage(e))
                remaining = queue.slice(i)
              }
              break
            }
          }
        } finally {
          // Ops appended while this flush was awaiting the network are in
          // state but not in our snapshot. Losing them here was a real bug:
          // stamp twice quickly and the second waypoint vanished.
          const added = get().pending.slice(queue.length)
          set({
            pending: [...remaining, ...added],
            failed: [...get().failed, ...newlyFailed],
            syncing: false,
          })
          if (progressed) flushSeq++
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
        const uid = get().ownerId
        const photos = get()
          .visible()
          .find((w) => w.id === id)?.photos
        // Only paths in our own folder — the storage policy will not let us
        // delete a teammate's uploads.
        const photoPaths = (photos ?? []).filter((p) =>
          uid ? p.startsWith(`${uid}/`) : false,
        )
        set({
          pending: [...get().pending, { kind: 'delete', id, photoPaths }],
        })
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

        const before = get().visible().find((w) => w.id === id)
        if (!before) throw new Error('That waypoint is no longer there')

        const room = Math.max(0, 8 - before.photos.length)
        if (room === 0) throw new Error('That waypoint already has 8 photos')

        const uploaded = await uploadPhotos(uid, id, files.slice(0, room))
        if (uploaded.length === 0) throw new Error('Photo upload failed')

        // Re-read after the upload: a teammate may have attached photos to the
        // same waypoint while ours were in flight, and patching from the
        // pre-upload array would erase theirs from the row.
        const current =
          get().visible().find((w) => w.id === id)?.photos ?? before.photos
        await get().update(id, { photos: [...current, ...uploaded] })
        return uploaded.length
      },

      stagePhotos: (id, files) => {
        if (files.length === 0) return
        const current = stagedFiles.get(id) ?? []
        stagedFiles.set(id, [...current, ...files].slice(0, 8))
        set({ stagedPhotoCount: stagedCounts() })
      },

      stagedFor: (id) => stagedFiles.get(id) ?? [],

      drainStagedPhotos: async () => {
        if (!online() || stagedFiles.size === 0) return 0
        let uploaded = 0
        for (const [id, files] of [...stagedFiles]) {
          // If the waypoint was deleted while its photos waited, drop them —
          // there is nothing left to attach to.
          if (!get().visible().some((w) => w.id === id)) {
            stagedFiles.delete(id)
            continue
          }
          try {
            uploaded += await get().addPhotos(id, files)
            stagedFiles.delete(id)
          } catch (e) {
            // Still offline or the upload failed — keep them staged.
            console.warn('staged photo upload failed', errorMessage(e))
          }
        }
        set({ stagedPhotoCount: stagedCounts() })
        return uploaded
      },

      retryFailed: async () => {
        const failed = get().failed
        if (failed.length === 0) return
        set({
          failed: [],
          pending: [
            ...failed.map((f) => ({ ...f.op, attempts: 0 })),
            ...get().pending,
          ],
        })
        await get().flush()
      },

      discardFailed: () => set({ failed: [] }),

      clearLocal: () => {
        stagedFiles.clear()
        set({
          cache: [],
          pending: [],
          failed: [],
          lastSyncedAt: null,
          ownerId: null,
          stagedPhotoCount: {},
        })
      },

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
        failed: s.failed,
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
