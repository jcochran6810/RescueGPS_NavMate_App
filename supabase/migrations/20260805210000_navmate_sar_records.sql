-- SAR datum collection: the records a single field unit gathers while
-- searching for a victim — the LKP, on-scene conditions, drift-marker
-- observations and clues.
--
-- Shaped to merge with the RescueGPS schema later:
--   * client_id UNIQUE — RescueGPS's offline-sync contract. The client
--     generates it and upserts on conflict, so a retry collapses instead of
--     duplicating (its asset_tracks/field_events do exactly this).
--   * recorded_at (device time when observed) is separate from created_at.
--   * kind-specific detail lives in payload jsonb, so mapping into
--     RescueGPS's typed tables (lkp_history, field_drift_data,
--     field_events/evidence, weather_snapshots) is a projection, not a
--     migration.
-- Scoping follows NavMate's model: private to the account unless given a
-- team_id. RescueGPS scopes by incident instead; when the databases merge,
-- team_id maps to incident participation.

create table public.sar_records (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null unique,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id     uuid references public.teams(id) on delete set null,
  kind        text not null check (kind in ('lkp', 'clue', 'drift_marker', 'environment')),
  lat         double precision check (lat >= -90 and lat <= 90),
  lon         double precision check (lon >= -180 and lon <= 180),
  recorded_at timestamptz not null,
  payload     jsonb not null default '{}'::jsonb,
  note        text not null default '' check (char_length(note) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index sar_records_user_id_idx on public.sar_records(user_id);
create index sar_records_team_id_idx on public.sar_records(team_id) where team_id is not null;
create index sar_records_kind_idx    on public.sar_records(kind);

create trigger sar_records_touch_updated_at before update on public.sar_records
  for each row execute function public.touch_updated_at();

-- RLS mirrors waypoints: authenticated-only, no anon policy anywhere.
alter table public.sar_records enable row level security;

create policy "sar: read own or shared with my team" on public.sar_records
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
  );

create policy "sar: insert own" on public.sar_records
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (team_id is null or public.is_team_member(team_id))
  );

create policy "sar: update own or as team admin" on public.sar_records
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  )
  with check (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  );

create policy "sar: delete own or as team admin" on public.sar_records
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  );
