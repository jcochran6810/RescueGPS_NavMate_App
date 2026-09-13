-- NavMate re-homed. Part 2 of 3: NavMate incidents, SAR datum records, and
-- the team RPCs.
--
-- SUPERSEDED by 20260913041316_navmate_incidents_merge_into_incidents.sql,
-- which drops this table and moves NavMate onto the command system's own
-- `incidents`. Kept because it is the history of how the schema got here, and
-- because the RLS and column choices below carried across the merge. On a
-- fresh database both files still run in order: this one creates the table,
-- the later one folds it away.
--
-- `navmate_incidents` was deliberately NOT the command system's `incidents`.
-- That table is 50 columns with live rows, scoped by organisation and
-- participant; this one is the small offline-first container a field unit
-- opens, scoped by team, with the `client_id` idempotency key that makes
-- offline sync work. Merging the two is a decision about access models, not a
-- rename, and is left for when somebody wants the live field-to-command
-- tie-in.

create table public.navmate_incidents (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null unique,
  team_id         uuid references public.teams(id) on delete set null,
  incident_number text not null check (char_length(incident_number) <= 40),
  incident_type   text not null check (incident_type in (
    'piw', 'kayak', 'jetski', 'swimmer', 'diver', 'missing_vessel',
    'capsized_vessel', 'debris_field', 'life_raft', 'found_watercraft',
    'vessel_overdue', 'vessel_in_distress', 'missing_person', 'medical',
    'fire', 'hazmat', 'other',
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

create index navmate_incidents_team_id_idx on public.navmate_incidents(team_id) where team_id is not null;
create index navmate_incidents_created_by_idx on public.navmate_incidents(created_by);
create index navmate_incidents_status_idx on public.navmate_incidents(status);

create trigger navmate_incidents_touch_updated_at before update on public.navmate_incidents
  for each row execute function public.navmate_touch_updated_at();

alter table public.navmate_incidents enable row level security;

-- Any team member may update — the incident is the whole team's shared state,
-- and the unit closing the search is rarely the one that opened it.
create policy "incidents: read own or shared with my team" on public.navmate_incidents
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_member(team_id))
  );

create policy "incidents: insert own" on public.navmate_incidents
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (team_id is null or public.navmate_is_team_member(team_id))
  );

create policy "incidents: update own or as team member" on public.navmate_incidents
  for update to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_member(team_id))
  )
  with check (
    created_by = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_member(team_id))
  );

create policy "incidents: delete own or as team admin" on public.navmate_incidents
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  );

-- SAR datum records. Shaped to project onto the command system's typed tables
-- (lkp_history, field_drift_data, field_events, weather_snapshots) — kind
-- decides which, and the detail lives in payload jsonb so that is a
-- projection, not a migration.
create table public.sar_records (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null unique,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id     uuid references public.teams(id) on delete set null,
  -- SET NULL, not CASCADE: the record of what was observed outlives an
  -- incident opened by mistake and deleted.
  incident_id uuid references public.navmate_incidents(id) on delete set null,
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
create index sar_records_incident_id_idx on public.sar_records(incident_id)
  where incident_id is not null;

create trigger sar_records_touch_updated_at before update on public.sar_records
  for each row execute function public.navmate_touch_updated_at();

alter table public.sar_records enable row level security;

create policy "sar: read own or shared with my team" on public.sar_records
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_member(team_id))
  );

create policy "sar: insert own" on public.sar_records
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (team_id is null or public.navmate_is_team_member(team_id))
  );

create policy "sar: update own or as team admin" on public.sar_records
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  )
  with check (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  );

create policy "sar: delete own or as team admin" on public.sar_records
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  );

-- Team creation / joining go through SECURITY DEFINER RPCs so a team and its
-- first owner row are written atomically, and so join codes can be checked
-- without exposing every team row to a lookup.

create or replace function public.create_team(p_name text)
returns public.teams language plpgsql security definer set search_path = '' as $$
declare
  v_team  public.teams;
  v_code  text;
  v_tries int := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Team name is required' using errcode = '22023';
  end if;

  loop
    v_code := public.navmate_generate_join_code();
    exit when not exists (select 1 from public.teams t where t.join_code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 25 then
      raise exception 'Could not allocate a join code' using errcode = '55000';
    end if;
  end loop;

  insert into public.teams (name, join_code, created_by)
  values (btrim(p_name), v_code, (select auth.uid()))
  returning * into v_team;

  insert into public.team_members (team_id, user_id, role)
  values (v_team.id, (select auth.uid()), 'owner');

  return v_team;
end;
$$;

create or replace function public.join_team(p_code text)
returns public.teams language plpgsql security definer set search_path = '' as $$
declare
  v_team public.teams;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_team from public.teams t
  where t.join_code = upper(btrim(coalesce(p_code, '')));

  if not found then
    raise exception 'Invalid join code' using errcode = '22023';
  end if;

  insert into public.team_members (team_id, user_id, role)
  values (v_team.id, (select auth.uid()), 'member')
  on conflict (team_id, user_id) do nothing;

  return v_team;
end;
$$;

create or replace function public.rotate_join_code(p_team_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_code  text;
  v_tries int := 0;
begin
  if not public.navmate_is_team_admin(p_team_id) then
    raise exception 'Only team admins can rotate the join code' using errcode = '42501';
  end if;

  loop
    v_code := public.navmate_generate_join_code();
    exit when not exists (select 1 from public.teams t where t.join_code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 25 then
      raise exception 'Could not allocate a join code' using errcode = '55000';
    end if;
  end loop;

  update public.teams set join_code = v_code where id = p_team_id;
  return v_code;
end;
$$;
