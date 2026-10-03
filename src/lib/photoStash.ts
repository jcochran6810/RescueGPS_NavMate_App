/**
 * Photos taken out of signal, kept on the phone until they reach the server.
 *
 * Before this, a photo taken with no signal lived in memory only: close the
 * app, let the phone kill it in a pocket, or reload, and the photo was gone.
 * A clue photo taken offline was never sent at all. Now each one is written to
 * the phone's IndexedDB the moment it is taken and removed only after the
 * upload has landed, so a phone that loses signal (or is switched off) still
 * sends it when it comes back.
 *
 * Kinds:
 *   'waypoint' — uploaded by useWaypoints.drainStagedPhotos (addPhotos)
 *   'sar'      — a clue / record photo, uploaded here through
 *                useSarRecords.attachPhoto
 *
 * With no IndexedDB (tests, very old browsers) it falls back to memory and
 * says so through `durable()`.
 */

export type PhotoKind = 'waypoint' | 'sar'

export interface StashedPhoto {
  id: string
  kind: PhotoKind
  targetId: string
  ownerId: string | null
  name: string
  type: string
  blob: Blob
  createdAt: string
}

const DB_NAME = 'navmate-photos'
const STORE = 'photos'

const memory = new Map<string, StashedPhoto>()

function hasIdb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** True when stashed photos survive the app being closed. */
export const durable = (): boolean => hasIdb()

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        t.oncomplete = () => resolve(req ? (req.result as T) : undefined)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `p-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Keep these photos for `targetId` until they are uploaded. */
export async function stashPhotos(
  kind: PhotoKind,
  targetId: string,
  ownerId: string | null,
  files: File[],
): Promise<StashedPhoto[]> {
  const rows: StashedPhoto[] = files.map((f) => ({
    id: newId(),
    kind,
    targetId,
    ownerId,
    name: f.name || 'photo.jpg',
    type: f.type || 'image/jpeg',
    blob: f,
    createdAt: new Date().toISOString(),
  }))
  if (!hasIdb()) {
    for (const r of rows) memory.set(r.id, r)
    return rows
  }
  try {
    await tx('readwrite', (s) => {
      for (const r of rows) s.put(r)
    })
  } catch (e) {
    console.warn('photo stash failed, keeping in memory', e instanceof Error ? e.message : String(e))
    for (const r of rows) memory.set(r.id, r)
  }
  return rows
}

/** Every stashed photo of one kind (all owners). */
export async function listStashed(kind?: PhotoKind): Promise<StashedPhoto[]> {
  let rows: StashedPhoto[] = [...memory.values()]
  if (hasIdb()) {
    try {
      const all = (await tx<StashedPhoto[]>('readonly', (s) => s.getAll())) ?? []
      rows = [...rows, ...all]
    } catch (e) {
      console.warn('photo stash read failed', e instanceof Error ? e.message : String(e))
    }
  }
  return kind ? rows.filter((r) => r.kind === kind) : rows
}

/** Forget stashed photos once uploaded (or their target is gone). */
export async function removeStashed(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  for (const id of ids) memory.delete(id)
  if (!hasIdb()) return
  try {
    await tx('readwrite', (s) => {
      for (const id of ids) s.delete(id)
    })
  } catch (e) {
    console.warn('photo stash delete failed', e instanceof Error ? e.message : String(e))
  }
}

/** A stashed photo as a File again (for the upload calls). */
export function asFile(p: StashedPhoto): File {
  try {
    return new File([p.blob], p.name, { type: p.type })
  } catch {
    // Very old WebViews without the File constructor: a Blob with a name.
    return Object.assign(p.blob, { name: p.name }) as File
  }
}

/**
 * Upload stashed clue / record photos. Waypoint photos go through
 * useWaypoints.drainStagedPhotos. Imported lazily so this module stays free
 * of store imports (the stores import it).
 */
export async function drainPendingPhotos(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0
  const rows = await listStashed('sar')
  if (rows.length === 0) return 0
  const { useSarRecords } = await import('@/store/useSarRecords')
  const { supabase } = await import('@/lib/supabase')
  const uid = (await supabase.auth.getSession()).data.session?.user?.id ?? null
  let sent = 0
  for (const r of rows) {
    // Only under the sign-in that took it: another crew member's photo waits
    // for them.
    if (r.ownerId && r.ownerId !== uid) continue
    const store = useSarRecords.getState()
    if (!store.visible().some((rec) => rec.id === r.targetId)) {
      // Not loaded yet, or deleted: keep it a week, then let it go.
      if (Date.now() - Date.parse(r.createdAt) > 7 * 86_400_000) await removeStashed([r.id])
      continue
    }
    const path = await store.uploadRecordPhoto(r.targetId, asFile(r))
    if (path) {
      await removeStashed([r.id])
      sent += 1
    }
  }
  return sent
}
