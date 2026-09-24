import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { supabase, errorMessage } from '@/lib/supabase'
import { isOffline, isTransient, describeError } from '@/lib/retry'
import {
  isIncoming,
  replyFields,
  type FieldMessage,
  type MessagePriority,
} from '@/lib/command'

/**
 * Messages between command and the field (`field_messages`, contract N6).
 *
 * Three queues ride here, each for its own reason:
 *
 * - **Outgoing messages** carry a `client_id` made on the phone and are sent
 *   as an insert that does nothing on a repeated `client_id`, so a message
 *   whose answer was lost in a dead zone is never delivered twice.
 * - **Receipts** — `delivered_at` when a message reaches this phone,
 *   `read_at` when the crew opens it. Queued too: a crew reading an order
 *   with no signal has still read it, and command wants to know when. The
 *   write is conditional on the column being empty, so the first time wins
 *   and a replay never moves it.
 * - The **inbox** itself is cached per incident, so the last orders are still
 *   on screen after the signal goes.
 */

interface Receipt {
  id: string
  field: 'delivered_at' | 'read_at'
  at: string
  attempts?: number
}

interface Outgoing {
  message: FieldMessage
  attempts?: number
}

interface FailedSend {
  message: FieldMessage
  reason: string
}

const MAX_ATTEMPTS = 3

interface MessageState {
  byIncident: Record<string, FieldMessage[]>
  outbox: Outgoing[]
  receipts: Receipt[]
  failed: FailedSend[]
  syncing: boolean
  ownerId: string | null

  load: (incidentId: string) => Promise<void>
  flush: () => Promise<void>
  subscribe: (incidentId: string) => () => void
  /**
   * Send a message. A reply goes back to its sender in the same thread;
   * anything else goes to the whole incident.
   */
  send: (
    incidentId: string,
    body: string,
    priority?: MessagePriority,
    replyTo?: FieldMessage | null,
  ) => Promise<boolean>
  /** Mark messages addressed to this crew as delivered (on receipt). */
  markDelivered: (incidentId: string, userId: string | null, unitId: string | null) => void
  markRead: (m: FieldMessage) => void
  discardFailed: () => void
  clearLocal: () => void
}

const online = () => typeof navigator === 'undefined' || navigator.onLine

function isTerminal(e: unknown): boolean {
  return !isOffline(e) && !isTransient(e)
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** A message this phone made that the server has not given an id yet. */
export const LOCAL_PREFIX = 'local:'

/** The server row for a message the outbox already has, matched on client_id. */
function mergeMessage(list: FieldMessage[], row: FieldMessage): FieldMessage[] {
  const i = list.findIndex(
    (m) => m.id === row.id || (row.client_id != null && m.client_id === row.client_id),
  )
  if (i < 0) return [row, ...list]
  const next = [...list]
  // Receipts only ever go from empty to set; never let a stale copy unset one.
  next[i] = {
    ...row,
    delivered_at: row.delivered_at ?? list[i].delivered_at,
    read_at: row.read_at ?? list[i].read_at,
  }
  return next
}

/**
 * What the screen shows for one incident: the cached inbox, anything still
 * waiting to go, and every receipt not yet confirmed, laid over the top.
 */
export function visibleMessages(
  cached: FieldMessage[],
  outbox: Outgoing[],
  receipts: Receipt[],
  incidentId: string,
): FieldMessage[] {
  let list = cached
  for (const o of outbox) {
    if (o.message.incident_id !== incidentId) continue
    if (!list.some((m) => m.client_id === o.message.client_id)) {
      list = [o.message, ...list]
    }
  }
  if (receipts.length > 0) {
    list = list.map((m) => {
      let next = m
      for (const r of receipts) {
        if (r.id === m.id && !next[r.field]) next = { ...next, [r.field]: r.at }
      }
      return next
    })
  }
  return list
}

export const useMessages = create<MessageState>()(
  persist(
    (set, get) => ({
      byIncident: {},
      outbox: [],
      receipts: [],
      failed: [],
      syncing: false,
      ownerId: null,

      load: async (incidentId) => {
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        if (uid && get().ownerId && get().ownerId !== uid) get().clearLocal()
        if (uid) set({ ownerId: uid })
        if (!online()) return
        await get().flush()
        // RLS returns only what this crew may read: to them, to their unit,
        // or to the whole incident — plus what they sent.
        const { data, error } = await supabase
          .from('field_messages')
          .select('*')
          .eq('incident_id', incidentId)
          .order('created_at', { ascending: false })
          .limit(200)
        if (error) {
          console.warn('messages load failed', errorMessage(error))
          return
        }
        let list = get().byIncident[incidentId] ?? []
        for (const row of (data ?? []) as FieldMessage[]) list = mergeMessage(list, row)
        set({ byIncident: { ...get().byIncident, [incidentId]: list } })
      },

      flush: async () => {
        if (!online() || get().syncing) return
        if (get().outbox.length === 0 && get().receipts.length === 0) return
        const uid =
          (await supabase.auth.getSession()).data.session?.user?.id ?? null
        const owner = get().ownerId
        if (!uid || (owner !== null && owner !== uid)) return

        set({ syncing: true })
        try {
          // Outgoing, in order.
          const out = get().outbox
          let remaining: Outgoing[] = []
          const failedNow: FailedSend[] = []
          const sent: FieldMessage[] = []
          for (let i = 0; i < out.length; i++) {
            const { message, attempts } = out[i]
            const {
              client_id, incident_id, sender_id, recipient_id, recipient_asset_id,
              body, priority, thread_id, in_reply_to, created_at,
            } = message
            const { error } = await supabase
              .from('field_messages')
              .upsert(
                {
                  client_id, incident_id, sender_id, recipient_id,
                  recipient_asset_id, body, priority, thread_id, in_reply_to,
                  created_at,
                },
                { onConflict: 'client_id', ignoreDuplicates: true },
              )
            if (!error) {
              sent.push(message)
              continue
            }
            if (isTerminal(error)) {
              const n = (attempts ?? 0) + 1
              if (n >= MAX_ATTEMPTS) {
                failedNow.push({ message, reason: describeError(error) })
                continue
              }
              remaining = [{ message, attempts: n }, ...out.slice(i + 1)]
            } else {
              remaining = out.slice(i)
            }
            break
          }
          // Sent messages leave the outbox, so they land in the cache — still
          // under their local id until the server's copy replaces them.
          const byIncident = { ...get().byIncident }
          for (const m of sent) {
            const list = byIncident[m.incident_id] ?? []
            // The server's copy may already be here, over Realtime; it wins.
            if (!list.some((x) => x.client_id === m.client_id)) {
              byIncident[m.incident_id] = [m, ...list]
            }
          }
          set({
            byIncident,
            outbox: [...remaining, ...get().outbox.slice(out.length)],
            failed: [...get().failed, ...failedNow],
          })

          // Receipts. Independent of each other, so one refused does not
          // hold up the rest.
          const rs = get().receipts
          const keep: Receipt[] = []
          for (const r of rs) {
            const { error } = await supabase
              .from('field_messages')
              .update({ [r.field]: r.at })
              .eq('id', r.id)
              .is(r.field, null)
            if (!error) continue
            const n = (r.attempts ?? 0) + 1
            if (!isTerminal(error) || n < MAX_ATTEMPTS) keep.push({ ...r, attempts: n })
          }
          const addedReceipts = get().receipts.slice(rs.length)
          set({ receipts: [...keep, ...addedReceipts] })
        } finally {
          set({ syncing: false })
        }
      },

      subscribe: (incidentId) => {
        const channel = supabase
          .channel(`navmate-messages-${incidentId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'field_messages',
              filter: `incident_id=eq.${incidentId}`,
            },
            (payload) => {
              if (payload.eventType === 'DELETE') return
              const row = payload.new as FieldMessage
              if (!row?.id) return
              const list = mergeMessage(get().byIncident[incidentId] ?? [], row)
              set({
                byIncident: { ...get().byIncident, [incidentId]: list },
                // The server copy of a message this phone sent: done with it.
                outbox: row.client_id
                  ? get().outbox.filter((o) => o.message.client_id !== row.client_id)
                  : get().outbox,
              })
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') void get().load(incidentId)
          })
        return () => void supabase.removeChannel(channel)
      },

      send: async (incidentId, body, priority = 'normal', replyTo = null) => {
        const text = body.trim()
        if (!text) return false
        const uid = (await supabase.auth.getSession()).data.session?.user?.id
        if (!uid) return false
        const clientId = newId()
        const thread = replyTo && !replyTo.id.startsWith(LOCAL_PREFIX)
          ? replyFields(replyTo)
          : { in_reply_to: null, thread_id: null }
        const message: FieldMessage = {
          id: `${LOCAL_PREFIX}${clientId}`,
          client_id: clientId,
          incident_id: incidentId,
          sender_id: uid,
          // A reply goes to whoever sent the original; a new message to the
          // whole incident, which is where command reads field traffic.
          recipient_id: replyTo ? replyTo.sender_id : null,
          recipient_asset_id: null,
          body: text,
          priority,
          thread_id: thread.thread_id,
          in_reply_to: thread.in_reply_to,
          delivered_at: null,
          read_at: null,
          created_at: new Date().toISOString(),
        }
        set({ ownerId: uid, outbox: [...get().outbox, { message }] })
        await get().flush()
        return true
      },

      markDelivered: (incidentId, userId, unitId) => {
        const list = visibleMessages(
          get().byIncident[incidentId] ?? [],
          [],
          get().receipts,
          incidentId,
        )
        const at = new Date().toISOString()
        const fresh: Receipt[] = list
          .filter(
            (m) =>
              !m.delivered_at &&
              !m.id.startsWith(LOCAL_PREFIX) &&
              isIncoming(m, userId, unitId),
          )
          .map((m) => ({ id: m.id, field: 'delivered_at', at }))
        if (fresh.length === 0) return
        set({ receipts: [...get().receipts, ...fresh] })
        void get().flush()
      },

      markRead: (m) => {
        if (m.read_at || m.id.startsWith(LOCAL_PREFIX)) return
        if (get().receipts.some((r) => r.id === m.id && r.field === 'read_at')) return
        const at = new Date().toISOString()
        const add: Receipt[] = [{ id: m.id, field: 'read_at', at }]
        // Read implies delivered; never leave a message read but undelivered.
        if (!m.delivered_at) add.unshift({ id: m.id, field: 'delivered_at', at })
        set({ receipts: [...get().receipts, ...add] })
        void get().flush()
      },

      discardFailed: () => set({ failed: [] }),

      clearLocal: () =>
        set({ byIncident: {}, outbox: [], receipts: [], failed: [], ownerId: null }),
    }),
    {
      name: 'navmate.messages.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        byIncident: s.byIncident,
        outbox: s.outbox,
        receipts: s.receipts,
        failed: s.failed,
        ownerId: s.ownerId,
      }),
    },
  ),
)
