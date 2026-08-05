-- Runtime error log, the last piece of the MyTradeCrate admin pattern: any
-- signed-in client may report an error, only the platform admin reads them,
-- and the metrics call counts them so the dashboard can say "healthy" with
-- evidence rather than optimism.

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
  using (public.is_platform_admin());

create policy "app_errors: authenticated log" on public.app_errors
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- admin_metrics grows error counts.
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
    'errors_24h',         (select count(*) from public.app_errors where created_at > now() - interval '24 hours'),
    'errors_7d',          (select count(*) from public.app_errors where created_at > now() - interval '7 days'),
    'storage_bytes',      (select coalesce(sum((o.metadata->>'size')::bigint), 0)
                             from storage.objects o where o.bucket_id = 'waypoint-photos'),
    'generated_at',       to_jsonb(now())
  ) into result;

  return result;
end;
$$;
