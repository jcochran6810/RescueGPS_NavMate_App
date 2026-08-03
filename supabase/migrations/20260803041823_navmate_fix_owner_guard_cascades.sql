-- The last-owner guard was firing on cascade deletes as well as on real
-- departures, which made it impossible to delete a team (its memberships
-- cascade) or to delete a user account (their memberships cascade). In both
-- cases the parent row is already gone by the time the cascade reaches
-- team_members, so that is exactly what we test for.

create or replace function public.guard_last_owner()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_team_id uuid := coalesce(old.team_id, new.team_id);
  v_owners  int;
begin
  -- The team itself is being deleted; let its roster go with it.
  if not exists (select 1 from public.teams t where t.id = v_team_id) then
    return coalesce(new, old);
  end if;

  -- The account is being deleted; let their memberships go with it.
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into v_owners
    from public.team_members tm
    where tm.team_id = v_team_id and tm.role = 'owner';
    if v_owners <= 1 then
      raise exception 'A team must keep at least one owner' using errcode = '23514';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;
