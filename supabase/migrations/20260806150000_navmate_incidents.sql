-- Incidents: the container a search runs in, so every unit on the same team
-- is working the same search and everything they collect hangs off it.
--
-- Shaped to be adopted by RescueGPS (rescuegps-navigator-pro) when an
-- incident commander comes on scene. Column names, the incident_type list
-- and the status list mirror that system's `incidents` table exactly —
-- including `lkp_lng` (their convention is lng, never lon) and the
-- authoritative session-40 CHECK lists — so adoption is an INSERT, not a
-- translation. Three deliberate divergences, each fixing a documented flaw
-- on the command side:
--   * client_id UNIQUE — their incidents table has no idempotency key, and
--     their offline fallback (`local-<ts>-<rand>` ids) never syncs. Ours
--     upserts on conflict like every other NavMate queue.
--   * incident_time is a real column — they overload lkp_time to mean
--     either "last seen here" or "went into the water", which silently
--     zeroes drift time. We keep both.
--   * no password column — they store incident passwords in plaintext.
--     NavMate scopes by team membership instead; join the team, join the
--     search.
-- NavMate additions: team_id (maps to incident participation when the
-- databases merge), and no UNIQUE on incident_number — two units opening
-- incidents offline cannot check uniqueness, so the number carries enough
-- random suffix to make collisions unlikely instead.

create table public.incidents (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null unique,
  team_id         uuid references public.teams(id) on delete set null,
  incident_number text not null check (char_length(incident_number) <= 40),
  incident_type   text not null check (incident_type in (
    -- the RescueGPS session-40 list: legacy codes…
    'piw', 'kayak', 'jetski', 'swimmer', 'diver', 'missing_vessel',
    'capsized_vessel', 'debris_field', 'life_raft', 'found_watercraft',
    'vessel_overdue', 'vessel_in_distress', 'missing_person', 'medical',
    'fire', 'hazmat', 'other',
    -- …and ontology canonical codes
    'missing_person_piw', 'debris_found', 'medical_emergency',
    'missing_person_land', 'mass_rescue'
  )),
  incident_name   text not null default '' check (char_length(incident_name) <= 200),
  urgency_level   text not null default 'high'
    check (urgency_level in ('critical', 'high', 'medium', 'low')),
  status          text not null default 'active' check (status in (
    'active', 'suspended', 'completed', 'cancelled',
    'found_alive', 'found_deceased', 'not_found', 'false_alarm', 'closed'
  )),
  lkp_lat         double precision check (lkp_lat >= -90 and lkp_lat <= 90),
  lkp_lng         double precision check (lkp_lng >= -180 and lkp_lng <= 180),
  lkp_time        timestamptz,
  lkp_source      text,
  -- When the person actually went in the water — drift time starts here,
  -- falling back to lkp_time when unknown.
  incident_time   timestamptz,
  summary         text not null default '' check (char_length(summary) <= 4000),
  created_by      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index incidents_team_id_idx on public.incidents(team_id) where team_id is not null;
create index incidents_created_by_idx on public.incidents(created_by);
create index incidents_status_idx on public.incidents(status);

create trigger incidents_touch_updated_at before update on public.incidents
  for each row execute function public.touch_updated_at();

-- RLS mirrors sar_records: authenticated only, no anon policy anywhere.
-- Any team member may update — the incident is the whole team's shared
-- state, and the unit closing the search is rarely the one that opened it.
alter table public.incidents enable row level security;

create policy "incidents: read own or shared with my team" on public.incidents
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
  );

create policy "incidents: insert own" on public.incidents
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (team_id is null or public.is_team_member(team_id))
  );

create policy "incidents: update own or as team member" on public.incidents
  for update to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
  )
  with check (
    created_by = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
  );

create policy "incidents: delete own or as team admin" on public.incidents
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  );

-- Everything a unit collects ties to the incident it was collected under.
-- SET NULL, not CASCADE: the record of what was observed outlives an
-- incident opened by mistake and deleted.
alter table public.sar_records
  add column incident_id uuid references public.incidents(id) on delete set null;

create index sar_records_incident_id_idx on public.sar_records(incident_id)
  where incident_id is not null;
