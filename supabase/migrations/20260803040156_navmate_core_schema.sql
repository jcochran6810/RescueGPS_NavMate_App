-- RescueGPS NavMate — core schema
-- Replaces the anonymous prototype table with account- and team-scoped storage.

drop table if exists public.waypoints cascade;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text not null default '',
  callsign   text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ teams
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

-- -------------------------------------------------------------- waypoints
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

-- ------------------------------------------------- membership helpers
-- SECURITY DEFINER so RLS policies on team_members can consult team_members
-- without recursing into their own policy.

create or replace function public.is_team_member(p_team_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team_id and tm.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_team_admin(p_team_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner','admin')
  );
$$;

create or replace function public.shares_team_with(p_user_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.team_members mine
    join public.team_members theirs on theirs.team_id = mine.team_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = p_user_id
  );
$$;

-- ------------------------------------------------------------- triggers
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger waypoints_touch_updated_at before update on public.waypoints
  for each row execute function public.touch_updated_at();
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, callsign)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'callsign', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
