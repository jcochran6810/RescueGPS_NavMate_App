-- Platform admin dashboard, ported from the MyTradeCrate pattern
-- (Pressure-washing repo) to a serverless SPA: there is no API server and
-- never a service-role key in this app, so everything the dashboard needs is
-- done with RLS read policies for the admin plus SECURITY DEFINER RPCs for
-- mutations — each mutation writing its own audit row.
--
--   * platform_admins   — who can see the Admin section (seeded by email)
--   * support_requests  — what users ask the platform admin for
--   * admin_actions     — audit log of every admin mutation
--   * is_platform_admin() + "platform admin read" policies on app tables
--   * admin_metrics(), admin_list_users(), admin_update_profile(),
--     admin_update_request() — the RPCs the dashboard calls

-- ---------------------------------------------------------- platform_admins
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  notes      text not null default ''
);

alter table public.platform_admins enable row level security;

-- ------------------------------------------------------- is_platform_admin
-- SECURITY DEFINER so policies on platform_admins itself (and every other
-- table) can consult the table without recursing into their own policy.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- Everyone may ask "am I an admin?" about themselves — that is how the app
-- decides whether to show the Admin section at all. Admins can see the list.
create policy "platform_admins: self or admin read" on public.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin());

-- --------------------------------------------------------- support_requests
-- "Take care of requests": users file these from the app (help, account
-- changes, team problems, bugs); the platform admin works the queue.
create table public.support_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text not null default 'help'
              check (kind in ('help', 'account', 'team', 'data', 'bug', 'other')),
  subject     text not null check (char_length(btrim(subject)) between 1 and 200),
  body        text not null default '' check (char_length(body) <= 4000),
  status      text not null default 'open'
              check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  admin_notes text not null default '' check (char_length(admin_notes) <= 4000),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index support_requests_status_idx on public.support_requests(status, created_at desc);
create index support_requests_user_idx   on public.support_requests(user_id);

create trigger support_requests_touch_updated_at before update on public.support_requests
  for each row execute function public.touch_updated_at();

alter table public.support_requests enable row level security;

create policy "requests: read own or as admin" on public.support_requests
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin());

create policy "requests: insert own" on public.support_requests
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'open'
    and admin_notes = ''
    and resolved_at is null
    and resolved_by is null
  );

-- No user UPDATE/DELETE policy: a filed request is part of the record.
-- Admin resolution goes through admin_update_request() so it is audited.

-- ------------------------------------------------------------ admin_actions
create table public.admin_actions (
  id            uuid primary key default gen_random_uuid(),
  -- Nullable: the audit row outlives the admin account (on delete set null).
  admin_user_id uuid references auth.users(id) on delete set null,
  action        text not null,
  target_kind   text,
  target_id     text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index admin_actions_created_idx on public.admin_actions(created_at desc);

alter table public.admin_actions enable row level security;

create policy "admin_actions: admin read" on public.admin_actions
  for select to authenticated
  using (public.is_platform_admin());
-- Inserts happen only inside SECURITY DEFINER RPCs, which bypass RLS.

-- ------------------------------------------- platform admin read everywhere
-- Mirrors MyTradeCrate's RLS bypass: the admin can *read* every app table so
-- the dashboard works with plain selects. Mutations still go through the
-- audited RPCs below.
create policy "platform admin read" on public.profiles
  for select to authenticated using (public.is_platform_admin());
create policy "platform admin read" on public.teams
  for select to authenticated using (public.is_platform_admin());
create policy "platform admin read" on public.team_members
  for select to authenticated using (public.is_platform_admin());
create policy "platform admin read" on public.waypoints
  for select to authenticated using (public.is_platform_admin());
create policy "platform admin read" on public.sar_records
  for select to authenticated using (public.is_platform_admin());

-- ----------------------------------------------------------- admin_metrics
create or replace function public.admin_metrics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'users_total',        (select count(*) from auth.users),
    'users_new_7d',       (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'users_new_30d',      (select count(*) from auth.users where created_at > now() - interval '30 days'),
    'users_active_7d',    (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'teams_total',        (select count(*) from public.teams),
    'team_members_total', (select count(*) from public.team_members),
    'waypoints_total',    (select count(*) from public.waypoints),
    'waypoints_7d',       (select count(*) from public.waypoints where created_at > now() - interval '7 days'),
    'photos_total',       (select coalesce(sum(jsonb_array_length(photos)), 0) from public.waypoints),
    'sar_records_total',  (select count(*) from public.sar_records),
    'sar_records_7d',     (select count(*) from public.sar_records where created_at > now() - interval '7 days'),
    'sar_by_kind',        (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
                             from (select kind, count(*) as n from public.sar_records group by kind) k),
    'requests_open',      (select count(*) from public.support_requests where status = 'open'),
    'requests_in_progress',(select count(*) from public.support_requests where status = 'in_progress'),
    'requests_total',     (select count(*) from public.support_requests),
    'storage_bytes',      (select coalesce(sum((o.metadata->>'size')::bigint), 0)
                             from storage.objects o where o.bucket_id = 'waypoint-photos'),
    'generated_at',       to_jsonb(now())
  ) into result;

  return result;
end;
$$;

revoke execute on function public.admin_metrics() from public, anon;
grant execute on function public.admin_metrics() to authenticated;

-- --------------------------------------------------------- admin_list_users
create or replace function public.admin_list_users()
returns table (
  user_id uuid,
  email text,
  full_name text,
  callsign text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  team_count bigint,
  waypoint_count bigint,
  sar_record_count bigint,
  open_requests bigint,
  is_admin boolean
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    u.id,
    u.email::text,
    coalesce(p.full_name, ''),
    coalesce(p.callsign, ''),
    u.created_at,
    u.last_sign_in_at,
    (select count(*) from public.team_members tm where tm.user_id = u.id),
    (select count(*) from public.waypoints w where w.user_id = u.id),
    (select count(*) from public.sar_records s where s.user_id = u.id),
    (select count(*) from public.support_requests r
      where r.user_id = u.id and r.status in ('open', 'in_progress')),
    exists (select 1 from public.platform_admins pa where pa.user_id = u.id)
  from auth.users u
  left join public.profiles p on p.id = u.id
  order by u.created_at;
end;
$$;

revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- ------------------------------------------------------ admin_update_profile
create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_full_name text,
  p_callsign text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.profiles
     set full_name = coalesce(p_full_name, full_name),
         callsign  = coalesce(p_callsign, callsign)
   where id = p_user_id;

  if not found then
    raise exception 'No profile for that user' using errcode = 'P0002';
  end if;

  insert into public.admin_actions (admin_user_id, action, target_kind, target_id, payload)
  values (
    (select auth.uid()), 'update_profile', 'profile', p_user_id::text,
    jsonb_build_object('full_name', p_full_name, 'callsign', p_callsign)
  );
end;
$$;

revoke execute on function public.admin_update_profile(uuid, text, text) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, text) to authenticated;

-- ------------------------------------------------------ admin_update_request
create or replace function public.admin_update_request(
  p_id uuid,
  p_status text,
  p_admin_notes text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('open', 'in_progress', 'resolved', 'dismissed') then
    raise exception 'Bad status' using errcode = '22023';
  end if;

  update public.support_requests
     set status      = p_status,
         admin_notes = coalesce(p_admin_notes, admin_notes),
         resolved_at = case when p_status in ('resolved', 'dismissed') then now() else null end,
         resolved_by = case when p_status in ('resolved', 'dismissed') then (select auth.uid()) else null end
   where id = p_id;

  if not found then
    raise exception 'No such request' using errcode = 'P0002';
  end if;

  insert into public.admin_actions (admin_user_id, action, target_kind, target_id, payload)
  values (
    (select auth.uid()), 'update_request', 'support_request', p_id::text,
    jsonb_build_object('status', p_status, 'admin_notes', p_admin_notes)
  );
end;
$$;

revoke execute on function public.admin_update_request(uuid, text, text) from public, anon;
grant execute on function public.admin_update_request(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------- seed
-- The platform admin, by email — no hardcoded user id, so this migration is
-- correct wherever it runs. If the account does not exist yet the insert is
-- a no-op and can be re-run after signup.
insert into public.platform_admins (user_id, granted_by, notes)
select u.id, u.id, 'bootstrap: platform admin'
from auth.users u
where lower(u.email) = 'jason.cochran@universalhazard.com'
on conflict (user_id) do nothing;
