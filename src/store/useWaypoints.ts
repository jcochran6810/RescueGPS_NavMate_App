import { setAsideFor, takeUnsent, prependFrom } from '@/lib/accountStash'
import { stashPhotos, listStashed, removeStashed, asFile } from '@/lib/photoStash'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage, PHOTO_BUCKET } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import type { NewWaypoint, Waypoint } from '@/lib/types'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'

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
      /**
       * When the crew deleted it. A delete is a soft delete (N10): the row
       * stays for the command system and gets this as `deleted_at`, stamped
       * at the tap rather than at sync so a queued delete keeps its real time.
       */
      deletedAt?: string
      /** Legacy: ops queued by builds that hard-deleted carry this. Ignored —
       *  a soft-deleted waypoint keeps its photographs. */
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
  /** Tag an existing waypoint to an incident (or clear it with null). */
  attachToIncident: (id: string, incidentId: string | null) => Promise<void>
  importMany: (inputs: NewWaypoint[], teamId: string | null) => Promise<number>
  /** Attach photos to a waypoint that already exists. Needs a connection. */
  addPhotos: (id: string, files: File[]) => Promise<number>
  /** Upload now; which files went up and which did not (nothing is kept). */
  addPhotosDetailed: (id: string, files: File[]) => Promise<{ sent: number; notSent: File[] }>
  /** Keep photos on the phone for a waypoint until they can be uploaded.
   *  Written to IndexedDB, so they survive the app being closed. */
  stagePhotos: (id: string, files: File[]) => Promise<void>
  stagedFor: (id: string) => File[]
  /** Upload everything staged. Called on reconnect. Returns photos uploaded. */
  drainStagedPhotos: () => Promise<number>
  /** Put the failed ops back at the head of the queue for another try. */
  retryFailed: () => Promise<void>
  discardFailed: () => void
  /** A row another device wrote or changed (live feed); removed when deleted. */
  applyRemote: (row: Waypoint, removed?: boolean) => void
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
  // A soft-deleted row is gone as far as the crew is concerned, however it
  // got into the cache.
  const byId = new Map(cache.filter((w) => !w.deleted_at).map((w) => [w.id, w]))
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

/**
 * The search a new waypoint belongs to: the incident the crew is on right
 * now, in the scope the rest of the app decides it with. Read at creation,
 * so a waypoint stamped offline carries it in its queued op.
 */
function currentIncidentId(): string | null {
  const teamId = useTeams.getState().activeTeamId
  return useIncidents.getState().activeIncident(teamId)?.id ?? null
}

/** Bumped whenever a flush lands at least one op, so a concurrent `load` can
 *  tell its server snapshot may already be stale. */
let flushSeq = 0

/** Photos for waypoints taken without signal (or whose upload failed). Each
 *  is also written to the phone's IndexedDB (lib/photoStash), so it survives
 *  the app being closed; the in-memory list is rebuilt from there on start. */
interface Staged {
  file: File
  stashId: string | null
  /** Who took it: only uploaded under that sign-in. */
  ownerId: string | null
}
const stagedFiles = new Map<string, Staged[]>()

function stagedCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, files] of stagedFiles) out[id] = files.length
  return out
}

let restored: Promise<void> | null = null
/** Bring back photos kept on the phone from an earlier run of the app. */
function restoreStaged(): Promise<void> {
  if (restored) return restored
  restored = listStashed('waypoint')
    .then((rows) => {
      for (const r of rows) {
        const list = stagedFiles.get(r.targetId) ?? []
        if (!list.some((x) => x.stashId === r.id)) list.push({ file: asFile(r), stashId: r.id, ownerId: r.ownerId })
        stagedFiles.set(r.targetId, list)
      }
      useWaypoints.setState({ stagedPhotoCount: stagedCounts() })
    })
    .catch(() => {})
  return restored
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
          if (get().ownerId && get().ownerId !== uid) {
            // Another account: its unsent work is set aside under it, not lost.
            if (!setAsideFor('waypoints', get().ownerId, { pending: get().pending, failed: get().failed })) return
            get().clearLocal()
          }
          if (uid) {
            const back = takeUnsent('waypoints', uid)
            if (back) set({ ownerId: uid, pending: prependFrom(back, 'pending', get().pending), failed: prependFrom(back, 'failed', get().failed) })
          }
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
              .is('deleted_at', null)
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
        // Ops the server accepted this pass. They leave the queue, so they
        // must be folded into the cache — otherwise a successfully synced
        // waypoint vanishes from the screen until the next load(). Found by
        // driving the build against a stub that, unlike this sandbox's
        // blocked network, actually accepts writes.
        const completed: PendingOp[] = []
        let progressed = false
        try {
          for (let i = 0; i < queue.length; i++) {
            const op = queue[i]
            try {
              if (op.kind === 'create') {
                const { id, user_id, team_id, name, lat, lon, note, photos, created_at } =
                  op.waypoint
                const incident_id = op.waypoint.incident_id ?? null
                const { error } = await supabase
                  .from('waypoints')
                  .upsert(
                    { id, user_id, team_id, incident_id, name, lat, lon, note, photos, created_at },
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
                // Soft delete (N10): the command system reads waypoints by
                // incident, and a row it has shown an IC must not simply
                // vanish from under them. Photos stay with the row for the
                // same reason.
                const { error } = await supabase
                  .from('waypoints')
                  .update({ deleted_at: op.deletedAt ?? new Date().toISOString() })
                  .eq('id', op.id)
                if (error) throw error
              }
              progressed = true
              completed.push(op)
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
            cache:
              completed.length > 0
                ? mergeUncached(get().cache, completed)
                : get().cache,
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

        // Photos that can't go up now (no signal, or a failed upload) are
        // kept on the phone and attached on the next sync pass.
        let keepForLater: File[] = photos
        if (photos.length > 0 && online()) {
          const up = await uploadPhotos(uid, id, photos)
          photoPaths = up.paths
          keepForLater = up.failed
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
          incident_id:
            input.incident_id !== undefined ? input.incident_id : currentIncidentId(),
          created_at: now,
          updated_at: now,
        }

        set({
          ownerId: uid,
          pending: [...get().pending, { kind: 'create', waypoint }],
        })
        if (keepForLater.length > 0) await get().stagePhotos(id, keepForLater)
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
        set({
          pending: [
            ...get().pending,
            { kind: 'delete', id, deletedAt: new Date().toISOString() },
          ],
        })
        await get().flush()
      },

      attachToIncident: async (id, incidentId) => {
        await get().update(id, { incident_id: incidentId })
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
        const { sent, notSent } = await get().addPhotosDetailed(id, files)
        // What did not go up is kept on the phone and goes on the next pass.
        if (notSent.length) await get().stagePhotos(id, notSent)
        return sent
      },

      addPhotosDetailed: async (id, files) => {
        if (files.length === 0) return { sent: 0, notSent: [] }
        if (!online()) throw new Error('Photos need a connection to upload')

        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) throw new Error('Sign in again to add photos')

        const before = get().visible().find((w) => w.id === id)
        if (!before) throw new Error('That waypoint is no longer there')

        const room = Math.max(0, 8 - before.photos.length)
        if (room === 0) throw new Error('That waypoint already has 8 photos')

        const { paths, failed } = await uploadPhotos(uid, id, files.slice(0, room))
        if (paths.length > 0) {
          // Re-read after the upload: a teammate may have attached photos to the
          // same waypoint while ours were in flight, and patching from the
          // pre-upload array would erase theirs from the row.
          const current =
            get().visible().find((w) => w.id === id)?.photos ?? before.photos
          await get().update(id, { photos: [...current, ...paths] })
        }
        return { sent: paths.length, notSent: failed }
      },

      stagePhotos: async (id, files) => {
        if (files.length === 0) return
        await restoreStaged()
        const uid = (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const current = stagedFiles.get(id) ?? []
        const room = Math.max(0, 8 - current.length)
        const kept = await stashPhotos('waypoint', id, uid, files.slice(0, room))
        stagedFiles.set(id, [
          ...current,
          ...kept.map((k) => ({ file: asFile(k), stashId: k.id, ownerId: uid })),
        ])
        set({ stagedPhotoCount: stagedCounts() })
      },

      stagedFor: (id) => (stagedFiles.get(id) ?? []).map((x) => x.file),

      drainStagedPhotos: async () => {
        await restoreStaged()
        if (!online() || stagedFiles.size === 0) return 0
        const uid = (await supabase.auth.getSession()).data.session?.user?.id ?? null
        let uploaded = 0
        for (const [id, all] of [...stagedFiles]) {
          // Another crew member's photos wait for them to sign in again.
          const items = all.filter((x) => !x.ownerId || x.ownerId === uid)
          const others = all.filter((x) => x.ownerId && x.ownerId !== uid)
          if (items.length === 0) continue
          // If the waypoint was deleted while its photos waited, drop them —
          // there is nothing left to attach to.
          if (!get().visible().some((w) => w.id === id)) {
            if (get().loading) continue
            if (others.length) stagedFiles.set(id, others)
            else stagedFiles.delete(id)
            await removeStashed(items.map((x) => x.stashId).filter((v): v is string => !!v))
            continue
          }
          try {
            const { sent, notSent } = await get().addPhotosDetailed(id, items.map((x) => x.file))
            uploaded += sent
            const left = items.filter((x) => notSent.includes(x.file))
            const done = items.filter((x) => !notSent.includes(x.file))
            await removeStashed(done.map((x) => x.stashId).filter((v): v is string => !!v))
            if (left.length + others.length) stagedFiles.set(id, [...left, ...others])
            else stagedFiles.delete(id)
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

      applyRemote: (row, removed = false) => {
        if (!row?.id) return
        const rest = get().cache.filter((x) => x.id !== row.id)
        set({ cache: removed || row.deleted_at ? rest : [row, ...rest] })
      },

      clearLocal: () => {
        // Photos kept on the phone are not cleared: each carries who took it.
        set({
          cache: [],
          pending: [],
          failed: [],
          lastSyncedAt: null,
          ownerId: null,
          stagedPhotoCount: stagedCounts(),
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
): Promise<{ paths: string[]; failed: File[] }> {
  const paths: string[] = []
  const failed: File[] = []
  for (const file of files.slice(0, 8)) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5)
    const path = `${userId}/${waypointId}/${newId()}.${ext}`
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, file, { contentType: file.type || 'image/jpeg' })
    if (!error) paths.push(path)
    else {
      console.warn('photo upload failed, keeping it to retry', errorMessage(error))
      failed.push(file)
    }
  }
  return { paths, failed }
}
