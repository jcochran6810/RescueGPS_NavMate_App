-- Joining an active search, and sharing what the units in it can see.
--
-- Until now a NavMate crew could only work an incident they opened themselves:
-- the app filtered on `client_id is not null` and there was no way in to
-- anything else. This is the other direction, which `fix_list.md` has carried
-- as "deliberately not built" since the tables were merged — a second boat, or
-- a boat arriving late, joining the search that is already running.
--
-- Everything here is ADDITIVE. The command system's own policies and functions
-- are untouched: no policy is dropped or narrowed, no function of theirs is
-- replaced, and every function added carries the `navmate_` prefix so it
-- cannot shadow one of theirs.
--
-- Three decisions worth keeping:
--
-- 1. **The password is verified in the database and never leaves it.**
--    `incidents` carries both `incident_password` (plaintext) and
--    `incident_password_hash`, and no row on this database has ever used
--    either. NavMate writes the hash only — bcrypt through pgcrypto — and
--    compares inside a SECURITY DEFINER function, so the app never reads a
--    hash it would then cache in localStorage.
--
-- 2. **Listing joinable incidents does not widen who can see what.**
--    `navmate_active_incidents` runs as definer for the participant counts,
--    so it repeats the command system's own visibility rule rather than
--    bypassing it: organisation-scoped incidents stay inside their
--    organisation.
--
-- 3. **Sharing is scoped to participants, through their own
--    `is_incident_participant()`.** A crew joining a search can see that
--    search's tracks and records and nothing else. Reading a teammate's
--    position was previously impossible for a field responder —
--    `asset_tracks_select_scoped` allows your own rows plus command staff —
--    which is why live sharing needed a policy rather than just a query.

-- ---------------------------------------------------------------- sharing

-- The area searched and where everyone is. Additive: the existing policy
-- stands, this one adds the incident you are actually on.
drop policy if exists "navmate: incident participants read tracks" on public.asset_tracks;
create policy "navmate: incident participants read tracks"
  on public.asset_tracks for select to authenticated
  using (incident_id is not null and public.is_incident_participant(incident_id));

-- The datum, the conditions, the drift markers and the clues. NavMate's own
-- table, so this is the first policy on it that is not team-scoped: an
-- incident is exactly the case where two teams work one search.
drop policy if exists "navmate: incident participants read records" on public.sar_records;
create policy "navmate: incident participants read records"
  on public.sar_records for select to authenticated
  using (incident_id is not null and public.is_incident_participant(incident_id));

-- An incident you have joined stays readable even if it is organisation
-- scoped and you are not in that organisation — otherwise a crew could join a
-- search and then lose sight of it.
drop policy if exists "navmate: participants read incident" on public.incidents;
create policy "navmate: participants read incident"
  on public.incidents for select to authenticated
  using (public.is_incident_participant(id));

-- ------------------------------------------------------------- the listing

-- Deliberately not `select *`: the password columns are in this table and the
-- point of the function is that they never come out of it. `needs_password`
-- is the only thing said about them.
create or replace function public.navmate_active_incidents()
returns table (
  id uuid,
  incident_number text,
  incident_name text,
  incident_type text,
  status text,
  urgency_level text,
  lkp_lat numeric,
  lkp_lng numeric,
  lkp_time timestamptz,
  incident_time timestamptz,
  created_at timestamptz,
  join_policy text,
  needs_password boolean,
  is_field_created boolean,
  participants integer,
  joined boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.incident_number,
    i.incident_name,
    i.incident_type,
    i.status,
    i.urgency_level,
    i.lkp_lat,
    i.lkp_lng,
    i.lkp_time,
    i.incident_time,
    i.created_at,
    coalesce(i.join_policy, 'approval') as join_policy,
    (coalesce(i.join_policy, 'approval') = 'password') as needs_password,
    (i.client_id is not null) as is_field_created,
    (
      select count(*)::integer from public.incident_participants p
      where p.incident_id = i.id and p.status = 'active'
    ) as participants,
    exists (
      select 1 from public.incident_participants p
      where p.incident_id = i.id and p.user_id = auth.uid() and p.status = 'active'
    ) as joined
  from public.incidents i
  where i.status in ('active', 'suspended')
    -- The command system's own visibility rule, repeated rather than
    -- bypassed. A definer function that ignored it would hand every crew
    -- every organisation's incidents.
    and (
      i.organization_id is null
      or public.current_user_org_id() is null
      or i.organization_id = public.current_user_org_id()
      or exists (
        select 1 from public.profiles pr
        where pr.id = auth.uid() and pr.role in ('admin', 'commander')
      )
      or public.is_incident_participant(i.id)
    )
  order by i.created_at desc
  limit 100;
$$;

-- --------------------------------------------------------------- joining

-- One word back, so the app knows what to show: 'joined', 'password_required',
-- 'wrong_password', 'password_unset', 'request_pending', 'closed' or
-- 'not_found'. Never an exception for a wrong password — a refusal is an
-- answer here, not a fault.
create or replace function public.navmate_join_incident(
  p_incident_id uuid,
  p_password text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_policy text;
  v_hash text;
  v_status text;
begin
  if v_uid is null then
    return 'not_found';
  end if;

  select coalesce(join_policy, 'approval'), incident_password_hash, status
    into v_policy, v_hash, v_status
  from public.incidents
  where id = p_incident_id;

  if not found then
    return 'not_found';
  end if;

  -- Already on it: idempotent, because a crew re-opening the app should not
  -- be asked for the password again.
  if exists (
    select 1 from public.incident_participants
    where incident_id = p_incident_id and user_id = v_uid and status = 'active'
  ) then
    return 'joined';
  end if;

  if v_status not in ('active', 'suspended') then
    return 'closed';
  end if;

  if v_policy = 'password' then
    if v_hash is null then
      -- Marked as password-protected with no password ever set. Refused
      -- rather than waved through: the incident says it wants one.
      return 'password_unset';
    end if;
    if p_password is null or length(p_password) = 0 then
      return 'password_required';
    end if;
    if extensions.crypt(p_password, v_hash) <> v_hash then
      return 'wrong_password';
    end if;
  elsif v_policy = 'approval' then
    -- Not a refusal — the IC decides. An existing pending request is left
    -- alone rather than duplicated.
    if not exists (
      select 1 from public.join_requests
      where incident_id = p_incident_id
        and requester_id = v_uid
        and status = 'pending'
    ) then
      insert into public.join_requests (incident_id, requester_id, requested_role)
      values (p_incident_id, v_uid, 'field_responder');
    end if;
    return 'request_pending';
  end if;

  insert into public.incident_participants (incident_id, user_id, participant_role, status)
  values (p_incident_id, v_uid, 'field_responder', 'active')
  on conflict (incident_id, user_id)
  do update set status = 'active', removed_at = null;

  return 'joined';
end;
$$;

-- Leaving. Marked removed rather than deleted, because who was on a search is
-- part of the record of it.
create or replace function public.navmate_leave_incident(p_incident_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.incident_participants
     set status = 'removed', removed_at = now()
   where incident_id = p_incident_id
     and user_id = auth.uid()
     and status = 'active';
$$;

-- Protecting an incident you are running. Writes the hash only — never
-- `incident_password`, which is a plaintext column this app declines to use.
-- Passing null clears the password and puts the incident back to open.
create or replace function public.navmate_set_incident_password(
  p_incident_id uuid,
  p_password text
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ok boolean;
begin
  select (created_by = v_uid or current_ic_id = v_uid) into v_ok
  from public.incidents where id = p_incident_id;
  if not coalesce(v_ok, false) then
    return 'not_allowed';
  end if;

  if p_password is null or length(p_password) = 0 then
    update public.incidents
       set incident_password_hash = null, join_policy = 'open'
     where id = p_incident_id;
    return 'cleared';
  end if;

  update public.incidents
     set incident_password_hash = extensions.crypt(p_password, extensions.gen_salt('bf')),
         join_policy = 'password'
   where id = p_incident_id;
  return 'set';
end;
$$;

-- ---------------------------------------------------------------- the roster

-- Who is on this search, by the name they answer to on the radio.
--
-- A function and not a policy on `profiles`, for the same reason
-- `navmate_team_profiles` is one: RLS is row-level, so a read policy would
-- hand over every column of the row — push tokens, emergency contacts,
-- clearance levels — to anyone who joined a search with them.
create or replace function public.navmate_incident_roster(p_incident_id uuid)
returns table (
  user_id uuid,
  full_name text,
  call_sign text,
  participant_role text,
  is_creator boolean,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id, pr.full_name, pr.call_sign, p.participant_role,
         p.is_creator, p.joined_at
  from public.incident_participants p
  left join public.profiles pr on pr.id = p.user_id
  where p.incident_id = p_incident_id
    and p.status = 'active'
    and public.is_incident_participant(p_incident_id)
  order by p.joined_at;
$$;

-- Where everyone is right now: the latest fix from each unit on the search,
-- with the name to put beside it. One call rather than a roster query, a
-- tracks query and a join done on a phone.
create or replace function public.navmate_incident_units(p_incident_id uuid)
returns table (
  user_id uuid,
  full_name text,
  call_sign text,
  lat numeric,
  lng numeric,
  heading_deg real,
  speed_mps real,
  accuracy_m real,
  recorded_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (t.user_id)
    t.user_id, pr.full_name, pr.call_sign,
    t.lat, t.lng, t.heading_deg, t.speed_mps, t.accuracy_m, t.recorded_at
  from public.asset_tracks t
  left join public.profiles pr on pr.id = t.user_id
  where t.incident_id = p_incident_id
    and public.is_incident_participant(p_incident_id)
    and t.recorded_at > now() - interval '12 hours'
  order by t.user_id, t.recorded_at desc;
$$;

-- Every NavMate function is authenticated-only. `anon` holds no policy and no
-- EXECUTE anywhere in this app, and the default PUBLIC grant is what would
-- quietly undo that.
revoke all on function public.navmate_active_incidents() from public, anon;
revoke all on function public.navmate_join_incident(uuid, text) from public, anon;
revoke all on function public.navmate_leave_incident(uuid) from public, anon;
revoke all on function public.navmate_set_incident_password(uuid, text) from public, anon;
revoke all on function public.navmate_incident_roster(uuid) from public, anon;
revoke all on function public.navmate_incident_units(uuid) from public, anon;

grant execute on function public.navmate_active_incidents() to authenticated;
grant execute on function public.navmate_join_incident(uuid, text) to authenticated;
grant execute on function public.navmate_leave_incident(uuid) to authenticated;
grant execute on function public.navmate_set_incident_password(uuid, text) to authenticated;
grant execute on function public.navmate_incident_roster(uuid) to authenticated;
grant execute on function public.navmate_incident_units(uuid) to authenticated;

-- No index is added for the shared read above: `idx_asset_tracks_incident_time`
-- already covers (incident_id, recorded_at) where incident_id is not null, and
-- a second one differing only in direction would be maintenance on every fix
-- every crew writes for nothing. Checked against the live index list rather
-- than assumed — one was created here first and then dropped for this reason.
--
-- `position` is filled by the command system's own BEFORE INSERT trigger
-- (`tf_asset_tracks_sync_geom`) from lat/lng, so NavMate inserts the numbers
-- and never constructs a geometry.
