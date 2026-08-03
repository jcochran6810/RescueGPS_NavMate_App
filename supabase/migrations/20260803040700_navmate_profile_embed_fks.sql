-- PostgREST can only embed a related row across a declared foreign key.
-- team_members.user_id and waypoints.user_id already point at auth.users;
-- these add the parallel link to public.profiles so the client can fetch a
-- roster (or "saved by") in one round trip instead of two.

alter table public.team_members
  add constraint team_members_user_id_profiles_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;

alter table public.waypoints
  add constraint waypoints_user_id_profiles_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;
