-- Row level security. Every table is authenticated-only; `anon` gets no policy
-- at all, so an unauthenticated visitor holding the publishable key sees nothing.

alter table public.profiles     enable row level security;
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.waypoints    enable row level security;

-- ---------------------------------------------------------------- profiles
create policy "profiles: read self or teammates" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_team_with(id));

create policy "profiles: insert self" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy "profiles: update self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ------------------------------------------------------------------- teams
create policy "teams: read teams i belong to" on public.teams
  for select to authenticated
  using (public.is_team_member(id));

create policy "teams: admins update" on public.teams
  for update to authenticated
  using (public.is_team_admin(id))
  with check (public.is_team_admin(id));

create policy "teams: creator deletes" on public.teams
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- No INSERT policy: teams are created only through public.create_team().

-- ------------------------------------------------------------ team_members
create policy "members: read roster of my teams" on public.team_members
  for select to authenticated
  using (public.is_team_member(team_id));

create policy "members: admins add" on public.team_members
  for insert to authenticated
  with check (public.is_team_admin(team_id));

create policy "members: admins change roles" on public.team_members
  for update to authenticated
  using (public.is_team_admin(team_id))
  with check (public.is_team_admin(team_id));

create policy "members: leave or be removed by admin" on public.team_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_team_admin(team_id));

-- --------------------------------------------------------------- waypoints
create policy "waypoints: read own or shared with my team" on public.waypoints
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_member(team_id))
  );

create policy "waypoints: insert own" on public.waypoints
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (team_id is null or public.is_team_member(team_id))
  );

create policy "waypoints: update own or as team admin" on public.waypoints
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  )
  with check (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  );

create policy "waypoints: delete own or as team admin" on public.waypoints
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or (team_id is not null and public.is_team_admin(team_id))
  );
