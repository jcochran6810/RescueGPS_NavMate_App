-- Integration audit 2026-10-02 — three faults in how a crew gets onto a
-- search, each found by running the flow as the real accounts in a
-- rolled-back transaction. NavMate-owned functions only; nothing of the
-- command system's is replaced or narrowed.
--
-- 1. A teammate on their own team's search was never a participant of it.
--    The command system's trigger adds the *creator* of an incident as a
--    participant; everyone else on the team was working the same incident
--    (team-scoped reads, `navmate: team members update`) without being on
--    it. Everything command sends goes through participation —
--    `integ_can_read_incident`, `integ_register_unit`, the hazard report
--    policy — so for every crew member but the one who opened the search:
--    the unit was refused (42501), assignments, messages, search areas and
--    the other units read as empty, and a hazard report was refused by RLS.
--    A team member now joins their team's incident directly, whatever its
--    join policy: the password and the IC's approval are there to keep
--    outsiders out, and the team already reads and updates this incident.
--
-- 2. Leaving a search and coming back failed. The re-join re-activated the
--    old participant row with an UPDATE, and the command system's guard
--    (`integ_guard_participant_update`, R8) refuses any participant change
--    other than leaving unless the caller is incident command — correctly,
--    for a hand-made REST call. The removed row is now replaced rather than
--    re-activated. The guard is untouched; DELETE is not what it guards, and
--    this function is the only door it was ever meant to leave open (R8:
--    "joins go through navmate_join_incident"). Nothing references
--    incident_participants.id, and the old re-activation cleared removed_at
--    anyway, so no history is lost that was kept before. A returning
--    creator keeps the IC role they were given on opening; anyone else
--    returns as a field responder, whatever role they left with.
--
-- 3. `is_field_created` read `client_id is not null`, which stopped meaning
--    "opened in NavMate" on 2026-09-30, when the command wizard began using
--    `client_id` as its own retry-safe save key (a random UUID, never the
--    incident's id). NavMate sets `client_id` to the incident's own id, and
--    only NavMate writes `team_id`.

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
  v_team uuid;
  v_prev public.incident_participants%rowtype;
begin
  if v_uid is null then
    return 'not_found';
  end if;

  select coalesce(join_policy, 'approval'), incident_password_hash, status, team_id
    into v_policy, v_hash, v_status, v_team
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

  if v_team is not null and public.navmate_is_team_member(v_team) then
    -- The team's own search (1): straight on.
    null;
  elsif v_policy = 'password' then
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

  -- Coming back after leaving (2): replace the removed row, never re-activate
  -- it — see the header.
  select * into v_prev
  from public.incident_participants
  where incident_id = p_incident_id and user_id = v_uid;
  if found then
    delete from public.incident_participants where id = v_prev.id;
  end if;

  insert into public.incident_participants
    (incident_id, user_id, participant_role, is_creator, status)
  values (
    p_incident_id,
    v_uid,
    case when coalesce(v_prev.is_creator, false) then v_prev.participant_role
         else 'field_responder' end,
    coalesce(v_prev.is_creator, false),
    'active'
  );

  -- A request this crew filed while waiting is answered now; leaving it
  -- pending would put a stale question in front of the IC.
  update public.join_requests
     set status = 'cancelled'
   where incident_id = p_incident_id
     and requester_id = v_uid
     and status = 'pending';

  return 'joined';
end;
$$;

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
    i.id, i.incident_number, i.incident_name, i.incident_type, i.status,
    i.urgency_level, i.lkp_lat, i.lkp_lng, i.lkp_time, i.incident_time,
    i.created_at,
    coalesce(i.join_policy, 'approval'),
    (coalesce(i.join_policy, 'approval') = 'password'),
    -- (3) NavMate's own: its client_id is the incident's id, or it is a
    -- team's incident. The command wizard's client_id is a separate key.
    (i.team_id is not null or i.client_id = i.id::text),
    (select count(*)::integer from public.incident_participants p
      where p.incident_id = i.id and p.status = 'active'),
    exists (select 1 from public.incident_participants p
      where p.incident_id = i.id and p.user_id = auth.uid() and p.status = 'active')
  from public.incidents i
  where i.status in ('active', 'suspended')
    -- The command system's own visibility rule, repeated rather than
    -- bypassed. A definer function that ignored it would hand every crew
    -- every organisation's incidents.
    and (
      i.organization_id is null
      or public.current_user_org_id() is null
      or i.organization_id = public.current_user_org_id()
      or exists (select 1 from public.profiles pr
                 where pr.id = auth.uid() and pr.role in ('admin', 'commander'))
      or public.is_incident_participant(i.id)
    )
  order by i.created_at desc
  limit 100;
$$;

-- Unchanged grants, restated: authenticated only, never anon or PUBLIC.
revoke all on function public.navmate_join_incident(uuid, text) from public, anon;
revoke all on function public.navmate_active_incidents() from public, anon;
grant execute on function public.navmate_join_incident(uuid, text) to authenticated;
grant execute on function public.navmate_active_incidents() to authenticated;
