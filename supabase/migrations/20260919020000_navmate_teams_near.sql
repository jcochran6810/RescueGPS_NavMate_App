-- Teams working near you, so a crew can find the one they mean.
--
-- A join code is six characters said over a radio or read off someone's
-- screen, and the hard part has never been typing it — it is knowing which
-- team you are being invited to when three departments are on the same water.
-- This lists the ones operating nearby so the code is confirmation rather
-- than a guess.
--
-- **It is not a way in.** The code is still required, and this function never
-- returns one. That is the whole shape of the thing: knowing a team exists
-- and roughly where it is gets you nothing you did not already get by looking
-- out of the wheelhouse window.
--
-- **It returns a distance and never a position.** A team's location is
-- derived from where its work is — the newest team-scoped waypoint or SAR
-- record — and handing those coordinates to anyone who asks would publish
-- where a crew has been searching. A range to it is what the crew needs and
-- is all they get.
--
-- **Only recently active teams appear.** A team that has logged nothing for a
-- month has no position worth reporting, and listing every team ever created
-- would make this a directory of the whole database.
-- PostGIS lives in `public` on this database, not `extensions` — checked
-- against pg_type rather than assumed, after the first version of this file
-- qualified the geography cast the other way and would not install.
create or replace function public.navmate_teams_near(
  p_lat double precision,
  p_lon double precision,
  p_radius_nm double precision default 10
)
returns table (
  id uuid,
  name text,
  members integer,
  distance_nm double precision,
  last_active timestamptz,
  joined boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with here as (
    select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as g
  ),
  activity as (
    -- Where the team has been working, newest first. Both tables carry a
    -- position and a team, and either is evidence the team is out there.
    select w.team_id, w.lat, w.lon, w.created_at
      from public.waypoints w
     where w.team_id is not null
       and w.created_at > now() - interval '30 days'
    union all
    select r.team_id, r.lat, r.lon, r.created_at
      from public.sar_records r
     where r.team_id is not null
       and r.lat is not null and r.lon is not null
       and r.created_at > now() - interval '30 days'
  ),
  latest as (
    select distinct on (a.team_id) a.team_id, a.lat, a.lon, a.created_at
      from activity a
     order by a.team_id, a.created_at desc
  )
  select
    t.id,
    t.name,
    (select count(*)::integer from public.team_members m where m.team_id = t.id),
    round(
      (st_distance(
        st_setsrid(st_makepoint(l.lon, l.lat), 4326)::geography,
        (select g from here)
      ) / 1852.0)::numeric, 1)::double precision,
    l.created_at,
    exists (
      select 1 from public.team_members m
      where m.team_id = t.id and m.user_id = auth.uid()
    )
  from latest l
  join public.teams t on t.id = l.team_id
  where p_lat is not null and p_lon is not null
    and st_dwithin(
      st_setsrid(st_makepoint(l.lon, l.lat), 4326)::geography,
      (select g from here),
      greatest(p_radius_nm, 0) * 1852.0
    )
  order by 4
  limit 25;
$$;

revoke all on function public.navmate_teams_near(double precision, double precision, double precision) from public, anon;
grant execute on function public.navmate_teams_near(double precision, double precision, double precision) to authenticated;
