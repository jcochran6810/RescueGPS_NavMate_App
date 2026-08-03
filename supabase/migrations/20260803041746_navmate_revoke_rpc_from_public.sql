-- Postgres grants EXECUTE on new functions to PUBLIC by default, so granting
-- to `authenticated` did not exclude `anon`. In practice an anonymous request
-- carries no `sub` claim and these RPCs raise 'Not authenticated', but the
-- grant itself should not be there. Revoke from PUBLIC and re-grant narrowly.

revoke execute on function public.create_team(text)       from public, anon;
revoke execute on function public.join_team(text)         from public, anon;
revoke execute on function public.rotate_join_code(uuid)  from public, anon;
revoke execute on function public.generate_join_code()    from public, anon;
revoke execute on function public.is_team_member(uuid)    from public, anon;
revoke execute on function public.is_team_admin(uuid)     from public, anon;
revoke execute on function public.shares_team_with(uuid)  from public, anon;

grant execute on function public.create_team(text)      to authenticated;
grant execute on function public.join_team(text)        to authenticated;
grant execute on function public.rotate_join_code(uuid) to authenticated;

-- The helpers are called from inside RLS policies, which run as the policy
-- owner, so `authenticated` needs execute but `anon` never does.
grant execute on function public.is_team_member(uuid)   to authenticated;
grant execute on function public.is_team_admin(uuid)    to authenticated;
grant execute on function public.shares_team_with(uuid) to authenticated;
