import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Incident } from '@/lib/types'

/**
 * Which incidents a crew's phone treats as its own.
 *
 * `incidents` is the command system's table, and its read policy lets every
 * signed-in user read every incident without an organisation — which on this
 * database is all of them. Since 2026-09-30 the command wizard also writes
 * `client_id`, so "readable and has a client_id" had become "every search
 * anyone opened, in either app". These tests hold the load to the crew's own
 * and their teams' field incidents, and the no-team rule to the crew's own.
 */

const ME = 'c0000000-0000-4000-8000-000000000003'
const OTHER = 'd0000000-0000-4000-8000-000000000004'
const TEAM = 'b0000000-0000-4000-8000-000000000002'

function incident(over: Partial<Incident>): Incident {
  const id = over.id ?? crypto.randomUUID()
  return {
    id,
    client_id: id,
    team_id: null,
    incident_number: 'INC-261002-AAAAA',
    incident_type: 'missing_person_piw',
    incident_name: '',
    urgency_level: 'high',
    status: 'active',
    lkp_lat: null,
    lkp_lng: null,
    lkp_time: null,
    lkp_source: null,
    incident_time: null,
    time_last_alive: null,
    summary: '',
    outcome: null,
    outcome_time: null,
    ended_at: null,
    created_by: ME,
    created_at: '2026-10-02T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    ...over,
  }
}

const calls: { table: string; method: string; args: unknown[] }[] = []
let incidentRows: Incident[] = []
let joinedRow: Incident | null = null
const rpcCalls: { name: string; args: unknown }[] = []
let rpcAnswer: unknown = 'joined'

function builder(table: string) {
  const chain: Record<string, unknown> = {}
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ table, method, args })
    return chain
  }
  for (const m of ['select', 'eq', 'or', 'not', 'order', 'is']) chain[m] = record(m)
  chain.maybeSingle = () => Promise.resolve({ data: joinedRow, error: null })
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      table === 'team_members'
        ? { data: [{ team_id: TEAM }], error: null }
        : { data: incidentRows, error: null },
    ).then(resolve)
  return chain
}

vi.mock('@/lib/supabase', () => ({
  errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e),
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: ME } } } }),
    },
    from: (table: string) => builder(table),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: rpcAnswer, error: null })
    },
  },
}))

import { useIncidents } from './useIncidents'
import { useTeams } from './useTeams'

beforeEach(() => {
  calls.length = 0
  rpcCalls.length = 0
  rpcAnswer = 'joined'
  incidentRows = []
  joinedRow = null
  vi.stubGlobal('navigator', { onLine: true })
  useTeams.setState({ activeTeamId: TEAM, teams: [] })
  useIncidents.setState({
    cache: [], pending: [], failed: [], loading: false, syncing: false,
    ownerId: ME, currentIncidentId: null,
  })
})

describe('incident load scope', () => {
  it('asks only for the crew\'s own incidents and their teams\'', async () => {
    await useIncidents.getState().load()
    const or = calls.find((c) => c.table === 'incidents' && c.method === 'or')
    expect(or?.args[0]).toBe(`created_by.eq.${ME},team_id.in.(${TEAM})`)
    expect(calls).toContainEqual({ table: 'team_members', method: 'eq', args: ['user_id', ME] })
  })

  it('drops a command incident even when the crew member opened it at a desk', async () => {
    const mine = incident({ created_at: '2026-10-02T01:00:00.000Z' })
    // The command wizard's shape: a save key that is not the id.
    const desk = incident({ client_id: crypto.randomUUID(), created_at: '2026-10-02T02:00:00.000Z' })
    incidentRows = [desk, mine]
    await useIncidents.getState().load()
    expect(useIncidents.getState().cache.map((i) => i.id)).toEqual([mine.id])
    expect(useIncidents.getState().activeIncident(null)?.id).toBe(mine.id)
  })

  it('still brings in the command incident the crew has joined', async () => {
    const joined = incident({ client_id: crypto.randomUUID(), created_by: OTHER })
    joinedRow = joined
    useIncidents.setState({ currentIncidentId: joined.id })
    await useIncidents.getState().load()
    expect(useIncidents.getState().activeIncident(null)?.id).toBe(joined.id)
  })
})

describe('the no-team rule', () => {
  it('never takes another crew\'s private search or a command incident for this crew\'s own', () => {
    // A cache written before the load was scoped.
    const theirs = incident({ created_by: OTHER, created_at: '2026-10-02T03:00:00.000Z' })
    const command = incident({ client_id: crypto.randomUUID(), created_at: '2026-10-02T02:00:00.000Z' })
    const mine = incident({ created_at: '2026-10-02T01:00:00.000Z' })
    useIncidents.setState({ cache: [theirs, command, mine] })
    expect(useIncidents.getState().activeIncident(null)?.id).toBe(mine.id)
    useIncidents.setState({ cache: [theirs, command] })
    expect(useIncidents.getState().activeIncident(null)).toBeNull()
  })

  it('a team incident is found by the team, whoever opened it', () => {
    const teamSearch = incident({ team_id: TEAM, created_by: OTHER })
    useIncidents.setState({ cache: [teamSearch] })
    expect(useIncidents.getState().activeIncident(TEAM)?.id).toBe(teamSearch.id)
    expect(useIncidents.getState().activeIncident(null)).toBeNull()
  })
})

describe('ensureParticipant — a teammate is put on the team\'s search', () => {
  it('joins a team search a teammate opened, once', async () => {
    // Verified live as the real accounts: until this, a teammate was never a
    // participant, so command's assignments, messages and the unit map never
    // reached them and their own unit was refused.
    const teamSearch = incident({ team_id: TEAM, created_by: OTHER })
    useIncidents.setState({ cache: [teamSearch] })
    expect(await useIncidents.getState().ensureParticipant(teamSearch.id)).toBe(true)
    expect(await useIncidents.getState().ensureParticipant(teamSearch.id)).toBe(true)
    expect(rpcCalls).toEqual([
      { name: 'navmate_join_incident', args: { p_incident_id: teamSearch.id, p_password: null } },
    ])
  })

  it('asks nothing for the creator, a private search or a search joined explicitly', async () => {
    const own = incident({ team_id: TEAM, created_by: ME })
    const priv = incident({})
    const joined = incident({ client_id: crypto.randomUUID(), created_by: OTHER })
    useIncidents.setState({ cache: [own, priv, joined] })
    for (const i of [own, priv, joined]) {
      expect(await useIncidents.getState().ensureParticipant(i.id)).toBe(true)
    }
    expect(rpcCalls).toEqual([])
  })

  it('asks again after an answer that is not "joined" (an incident still in the queue)', async () => {
    const teamSearch = incident({ team_id: TEAM, created_by: OTHER })
    useIncidents.setState({ cache: [teamSearch] })
    rpcAnswer = 'not_found'
    expect(await useIncidents.getState().ensureParticipant(teamSearch.id)).toBe(false)
    rpcAnswer = 'joined'
    expect(await useIncidents.getState().ensureParticipant(teamSearch.id)).toBe(true)
    expect(rpcCalls).toHaveLength(2)
  })
})

describe('ensureParticipant — only the crew\'s own team', () => {
  it('never re-asks for another team\'s search (a removal by its IC would become a join request)', async () => {
    const theirs = incident({ team_id: 'f0000000-0000-4000-8000-000000000009', created_by: OTHER })
    useIncidents.setState({ cache: [theirs] })
    expect(await useIncidents.getState().ensureParticipant(theirs.id)).toBe(true)
    expect(rpcCalls).toEqual([])
  })
})
