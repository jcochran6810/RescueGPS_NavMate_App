-- NavMate re-homed onto the RescueGPS database. Part 1 of 3: teams, roster,
-- waypoints and the NavMate-internal helpers.
--
-- See README.md in this directory for the full rationale. In short: `profiles`
-- is reused and never altered, NavMate-internal helpers are prefixed
-- `navmate_` so they cannot silently replace a same-named function belonging
-- to the command system (its handle_new_user() is exactly that hazard), and
-- NavMate's incidents table is `navmate_incidents`.
--
-- Tables are created before the functions because a SQL function body is
-- validated at creation time against the tables it names.

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  join_code  text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id   uuid not null references public.teams(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index team_members_user_id_idx on public.team_members(user_id);

create table public.waypoints (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id    uuid references public.teams(id) on delete set null,
  name       text not null default 'Waypoint' check (char_length(name) <= 200),
  lat        double precision not null check (lat >= -90 and lat <= 90),
  lon        double precision not null check (lon >= -180 and lon <= 180),
  note       text not null default '',
  photos     jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index waypoints_user_id_idx on public.waypoints(user_id);
create index waypoints_team_id_idx on public.waypoints(team_id) where team_id is not null;

create or replace function public.navmate_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- SECURITY DEFINER so RLS policies on team_members can consult team_members
-- without recursing into their own policy.
create or replace function public.navmate_is_team_member(p_team_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team_id and tm.user_id = (select auth.uid())
  );
$$;

create or replace function public.navmate_is_team_admin(p_team_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner','admin')
  );
$$;

create or replace function public.navmate_generate_join_code()
returns text language sql volatile set search_path = '' as $$
  -- Crockford-ish alphabet: no I, L, O, 0, 1 to avoid radio/handwriting mixups.
  select string_agg(
    substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', floor(random() * 31)::int + 1, 1), ''
  )
  from generate_series(1, 6);
$$;

-- The one place NavMate reads somebody else's profile row. A function rather
-- than a policy on `profiles` on purpose: that table is shared with the
-- command system and carries push tokens, emergency contacts and clearance
-- levels. A row-level policy cannot hand over three columns, only the row.
create or replace function public.navmate_team_profiles(p_team_id uuid)
returns table (id uuid, full_name text, call_sign text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(p.full_name, ''), coalesce(p.call_sign, '')
  from public.profiles p
  join public.team_members tm on tm.user_id = p.id
  where tm.team_id = p_team_id
    and public.navmate_is_team_member(p_team_id);
$$;

-- A team must never be left without an owner. SECURITY DEFINER because the
-- cascade check reads auth.users, which `authenticated` cannot select —
-- without it every membership delete raised "permission denied for table
-- users" and nobody could leave a team at all.
create or replace function public.navmate_guard_last_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_team_id uuid := coalesce(old.team_id, new.team_id);
  v_owners  int;
begin
  -- The team itself is being deleted; let its roster go with it.
  if not exists (select 1 from public.teams t where t.id = v_team_id) then
    return coalesce(new, old);
  end if;

  -- The account is being deleted; let their memberships go with it.
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into v_owners
    from public.team_members tm
    where tm.team_id = v_team_id and tm.role = 'owner';
    if v_owners <= 1 then
      raise exception 'A team must keep at least one owner' using errcode = '23514';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger team_members_guard_last_owner
  before update or delete on public.team_members
  for each row execute function public.navmate_guard_last_owner();

create trigger waypoints_touch_updated_at before update on public.waypoints
  for each row execute function public.navmate_touch_updated_at();

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.waypoints    enable row level security;

create policy "teams: read teams i belong to" on public.teams
  for select to authenticated
  using (public.navmate_is_team_member(id));

create policy "teams: admins update" on public.teams
  for update to authenticated
  using (public.navmate_is_team_admin(id))
  with check (public.navmate_is_team_admin(id));

create policy "teams: creator deletes" on public.teams
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- No INSERT policy: teams are created only through public.create_team().

create policy "members: read roster of my teams" on public.team_members
  for select to authenticated
  using (public.navmate_is_team_member(team_id));

create policy "members: admins add" on public.team_members
  for insert to authenticated
  with check (public.navmate_is_team_admin(team_id));

create policy "members: admins change roles" on public.team_members
  for update to authenticated
  using (public.navmate_is_team_admin(team_id))
  with check (public.navmate_is_team_admin(team_id));

create policy "members: leave or be removed by admin" on public.team_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.navmate_is_team_admin(team_id));

create policy "waypoints: read own or shared with my team" on public.waypoints
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_member(team_id))
  );

create policy "waypoints: insert own" on public.waypoints
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (team_id is null or public.navmate_is_team_member(team_id))
  );

create policy "waypoints: update own or as team admin" on public.waypoints
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  )
  with check (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  );

create policy "waypoints: delete own or as team admin" on public.waypoints
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.navmate_is_team_admin(team_id))
  );
