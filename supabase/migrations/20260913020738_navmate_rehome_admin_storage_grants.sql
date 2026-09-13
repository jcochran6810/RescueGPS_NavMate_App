-- NavMate re-homed. Part 3 of 3: platform admin, photo storage, grants, seed.

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  notes      text not null default ''
);

alter table public.platform_admins enable row level security;

-- SECURITY DEFINER so policies on platform_admins itself (and every other
-- table) can consult it without recursing into their own policy.
create or replace function public.navmate_is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = (select auth.uid())
  );
$$;

-- Everyone may ask "am I an admin?" about themselves — that is how the app
-- decides whether to show the Admin section at all. Admins can see the list.
create policy "platform_admins: self or admin read" on public.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()) or public.navmate_is_platform_admin());

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
  for each row execute function public.navmate_touch_updated_at();

alter table public.support_requests enable row level security;

create policy "requests: read own or as admin" on public.support_requests
  for select to authenticated
  using (user_id = (select auth.uid()) or public.navmate_is_platform_admin());

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
  using (public.navmate_is_platform_admin());
-- Inserts happen only inside SECURITY DEFINER RPCs, which bypass RLS.

create table public.app_errors (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  route      text not null default '' check (char_length(route) <= 200),
  message    text not null check (char_length(message) between 1 and 2000),
  stack      text not null default '' check (char_length(stack) <= 8000),
  severity   text not null default 'error' check (severity in ('warn', 'error', 'fatal')),
  context    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index app_errors_created_idx on public.app_errors(created_at desc);

alter table public.app_errors enable row level security;

create policy "app_errors: admin read" on public.app_errors
  for select to authenticated
  using (public.navmate_is_platform_admin());

create policy "app_errors: authenticated log" on public.app_errors
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- The admin can READ NavMate's own tables so the dashboard works with plain
-- selects. Deliberately NOT added to `profiles`: that table belongs to the
-- command system too, and admin_list_users() reads it through SECURITY
-- DEFINER instead.
create policy "platform admin read" on public.teams
  for select to authenticated using (public.navmate_is_platform_admin());
create policy "platform admin read" on public.team_members
  for select to authenticated using (public.navmate_is_platform_admin());
create policy "platform admin read" on public.waypoints
  for select to authenticated using (public.navmate_is_platform_admin());
create policy "platform admin read" on public.sar_records
  for select to authenticated using (public.navmate_is_platform_admin());
create policy "platform admin read" on public.navmate_incidents
  for select to authenticated using (public.navmate_is_platform_admin());

-- NOTE: auth.users on this database is shared with the command system, so the
-- user counts below and admin_list_users() cover both applications. That is
-- correct while one person administers both; it is stated here so nobody
-- reads "users_total" as a NavMate figure.
create or replace function public.admin_metrics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not public.navmate_is_platform_admin() then
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
    'errors_24h',         (select count(*) from public.app_errors where created_at > now() - interval '24 hours'),
    'errors_7d',          (select count(*) from public.app_errors where created_at > now() - interval '7 days'),
    'storage_bytes',      (select coalesce(sum((o.metadata->>'size')::bigint), 0)
                             from storage.objects o where o.bucket_id = 'waypoint-photos'),
    'generated_at',       to_jsonb(now())
  ) into result;

  return result;
end;
$$;

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
  if not public.navmate_is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The RETURNED column is still named `callsign` — that is the app's word for
  -- it and the shape useAdmin expects. The SOURCE column on this database is
  -- `call_sign`.
  return query
  select
    u.id,
    u.email::text,
    coalesce(p.full_name, ''),
    coalesce(p.call_sign, ''),
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

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_full_name text,
  p_callsign text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.navmate_is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.profiles
     set full_name = coalesce(p_full_name, full_name),
         call_sign = coalesce(p_callsign, call_sign)
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

create or replace function public.admin_update_request(
  p_id uuid,
  p_status text,
  p_admin_notes text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.navmate_is_platform_admin() then
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

-- Photo storage. Path convention: {user_id}/{waypoint_id}/{file}. The first
-- segment is the uploader, which is what the insert policy allows; a photo
-- added to a teammate's shared waypoint is still readable by the team because
-- the read policy matches the waypoint id in the second segment.
--
-- storage.objects is shared with the command system (which has its own
-- field_photos_* policies on it), so these are prefixed to stay out of each
-- other's way.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'waypoint-photos', 'waypoint-photos', false, 10485760,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "navmate photos: upload into own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'waypoint-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "navmate photos: read own or team-shared" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'waypoint-photos'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.waypoints w
        where w.id::text = (storage.foldername(name))[2]
          and w.team_id is not null
          and public.navmate_is_team_member(w.team_id)
      )
    )
  );

create policy "navmate photos: delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'waypoint-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Postgres grants EXECUTE on new functions to PUBLIC by default, so granting
-- to `authenticated` would not have excluded `anon`. Revoke from PUBLIC and
-- re-grant narrowly.
revoke execute on function public.navmate_generate_join_code()      from public, anon, authenticated;
revoke execute on function public.navmate_guard_last_owner()        from public, anon, authenticated;
revoke execute on function public.navmate_touch_updated_at()        from public, anon, authenticated;

revoke execute on function public.create_team(text)                 from public, anon;
revoke execute on function public.join_team(text)                   from public, anon;
revoke execute on function public.rotate_join_code(uuid)            from public, anon;
revoke execute on function public.navmate_is_team_member(uuid)      from public, anon;
revoke execute on function public.navmate_is_team_admin(uuid)       from public, anon;
revoke execute on function public.navmate_is_platform_admin()       from public, anon;
revoke execute on function public.navmate_team_profiles(uuid)       from public, anon;
revoke execute on function public.admin_metrics()                   from public, anon;
revoke execute on function public.admin_list_users()                from public, anon;
revoke execute on function public.admin_update_profile(uuid, text, text) from public, anon;
revoke execute on function public.admin_update_request(uuid, text, text) from public, anon;

grant execute on function public.create_team(text)                  to authenticated;
grant execute on function public.join_team(text)                    to authenticated;
grant execute on function public.rotate_join_code(uuid)             to authenticated;
grant execute on function public.navmate_team_profiles(uuid)        to authenticated;
grant execute on function public.admin_metrics()                    to authenticated;
grant execute on function public.admin_list_users()                 to authenticated;
grant execute on function public.admin_update_profile(uuid, text, text) to authenticated;
grant execute on function public.admin_update_request(uuid, text, text) to authenticated;

-- The membership helpers are evaluated inside RLS policies with the caller's
-- privileges, so `authenticated` must be able to execute them. They only ever
-- reveal the caller's own membership.
grant execute on function public.navmate_is_team_member(uuid)       to authenticated;
grant execute on function public.navmate_is_team_admin(uuid)        to authenticated;
grant execute on function public.navmate_is_platform_admin()        to authenticated;

-- The platform admin, by email — no hardcoded user id, so this is correct
-- wherever it runs. A no-op if the account does not exist yet; re-runnable
-- after signup.
insert into public.platform_admins (user_id, granted_by, notes)
select u.id, u.id, 'bootstrap: platform admin'
from auth.users u
where lower(u.email) = 'jason.cochran@universalhazard.com'
on conflict (user_id) do nothing;
