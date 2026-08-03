-- handle_new_user() and guard_last_owner() are trigger functions. They are
-- invoked by the trigger, never by a caller, but the default PUBLIC grant
-- also published them at /rest/v1/rpc/*. Take that away.
--
-- The remaining SECURITY DEFINER functions stay callable by `authenticated`
-- on purpose: create_team/join_team/rotate_join_code are the app's write path,
-- and is_team_member/is_team_admin/shares_team_with are evaluated inside RLS
-- policies with the caller's privileges, so `authenticated` must be able to
-- execute them. They only ever reveal the caller's own membership.

revoke execute on function public.handle_new_user()   from public, anon, authenticated;
revoke execute on function public.guard_last_owner()  from public, anon, authenticated;
