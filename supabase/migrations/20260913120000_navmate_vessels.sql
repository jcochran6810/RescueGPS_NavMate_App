-- Vessels — the boat a crew is actually on.
--
-- Added for the chart plotter: a route is only as good as the draft it was
-- planned for, and until now this app had nowhere to keep one. `profiles`
-- carries a name and a callsign and nothing about the hull, and every speed in
-- the app was a number typed into a form and forgotten when the screen closed.
--
-- Shared with the team rather than held per user, on purpose. A department's
-- Marine 2 has one draft, and a member retyping it from memory on their own
-- phone is how a boat ends up on a bar. One row, everyone on the team reads
-- it, admins maintain it — the same split `sar_records` uses, for the same
-- reason.
--
-- Everything is metric because that is the unit charted depths come in
-- (ENC `DRVAL1` is metres below chart datum). Feet are a display conversion in
-- src/lib/vessel.ts; keeping a draft in two units is how the two disagree.
--
-- `client_id` is the offline-sync idempotency contract shared with waypoints,
-- sar_records and incidents: the client generates it and upserts on conflict,
-- so a retry after a dropped connection collapses instead of duplicating.

create table public.vessels (
  id                  uuid primary key default gen_random_uuid(),
  client_id           text not null unique,
  team_id             uuid references public.teams(id) on delete set null,
  name                text not null default '' check (char_length(name) <= 80),
  callsign            text not null default '' check (char_length(callsign) <= 40),
  -- Deepest point of the hull below the waterline.
  draft_m             double precision not null default 0.9
                        check (draft_m > 0 and draft_m <= 15),
  -- Highest fixed point above the waterline. 0 = not recorded.
  air_draft_m         double precision not null default 0
                        check (air_draft_m >= 0 and air_draft_m <= 60),
  beam_m              double precision not null default 0
                        check (beam_m >= 0 and beam_m <= 40),
  length_m            double precision not null default 0
                        check (length_m >= 0 and length_m <= 200),
  cruise_speed_kn     double precision not null default 20
                        check (cruise_speed_kn > 0 and cruise_speed_kn <= 80),
  max_speed_kn        double precision not null default 35
                        check (max_speed_kn > 0 and max_speed_kn <= 120),
  -- US gallons per hour at cruise. 0 = not recorded.
  fuel_burn_gph       double precision not null default 0
                        check (fuel_burn_gph >= 0 and fuel_burn_gph <= 500),
  -- Water the coxswain wants under the keel on top of the draft. Added to the
  -- draft to give the safe depth the route planner uses, at chart datum.
  under_keel_margin_m double precision not null default 0.6
                        check (under_keel_margin_m >= 0 and under_keel_margin_m <= 10),
  -- Lateral stand-off kept from every charted hazard, metres.
  clearance_m         double precision not null default 30
                        check (clearance_m >= 0 and clearance_m <= 500),
  created_by          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index vessels_team_id_idx on public.vessels(team_id) where team_id is not null;
create index vessels_created_by_idx on public.vessels(created_by);

create trigger vessels_touch_updated_at before update on public.vessels
  for each row execute function public.touch_updated_at();

alter table public.vessels enable row level security;

-- Read: your own boats, plus every boat belonging to a team you are on.
create policy "vessels: read own or shared with my team"
  on public.vessels for select
  to authenticated
  using (
    created_by = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
  );

-- Insert: your own. A team boat may only be added by someone on that team.
create policy "vessels: insert own"
  on public.vessels for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and (team_id is null or public.is_team_member(team_id))
  );

-- Update: your own private boats, or a team boat if you administer the team.
-- Deliberately tighter than incidents: a draft is a safety figure, and a
-- member correcting it on a hunch is a change nobody else sees happen.
create policy "vessels: update own or as team admin"
  on public.vessels for update
  to authenticated
  using (
    (team_id is null and created_by = (select auth.uid()))
    or (team_id is not null and public.is_team_admin(team_id))
  )
  with check (
    (team_id is null and created_by = (select auth.uid()))
    or (team_id is not null and public.is_team_admin(team_id))
  );

create policy "vessels: delete own or as team admin"
  on public.vessels for delete
  to authenticated
  using (
    (team_id is null and created_by = (select auth.uid()))
    or (team_id is not null and public.is_team_admin(team_id))
  );
