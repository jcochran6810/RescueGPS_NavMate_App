-- Team creation / joining go through SECURITY DEFINER RPCs so a team and its
-- first owner row are written atomically, and so join codes can be checked
-- without exposing every team row to a lookup.

create or replace function public.generate_join_code()
returns text language sql volatile set search_path = '' as $$
  -- Crockford-ish alphabet: no I, L, O, 0, 1 to avoid radio/handwriting mixups.
  select string_agg(
    substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', floor(random() * 31)::int + 1, 1), ''
  )
  from generate_series(1, 6);
$$;

create or replace function public.create_team(p_name text)
returns public.teams language plpgsql security definer set search_path = '' as $$
declare
  v_team  public.teams;
  v_code  text;
  v_tries int := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Team name is required' using errcode = '22023';
  end if;

  loop
    v_code := public.generate_join_code();
    exit when not exists (select 1 from public.teams t where t.join_code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 25 then
      raise exception 'Could not allocate a join code' using errcode = '55000';
    end if;
  end loop;

  insert into public.teams (name, join_code, created_by)
  values (btrim(p_name), v_code, (select auth.uid()))
  returning * into v_team;

  insert into public.team_members (team_id, user_id, role)
  values (v_team.id, (select auth.uid()), 'owner');

  return v_team;
end;
$$;

create or replace function public.join_team(p_code text)
returns public.teams language plpgsql security definer set search_path = '' as $$
declare
  v_team public.teams;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_team from public.teams t
  where t.join_code = upper(btrim(coalesce(p_code, '')));

  if not found then
    raise exception 'Invalid join code' using errcode = '22023';
  end if;

  insert into public.team_members (team_id, user_id, role)
  values (v_team.id, (select auth.uid()), 'member')
  on conflict (team_id, user_id) do nothing;

  return v_team;
end;
$$;

create or replace function public.rotate_join_code(p_team_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_code  text;
  v_tries int := 0;
begin
  if not public.is_team_admin(p_team_id) then
    raise exception 'Only team admins can rotate the join code' using errcode = '42501';
  end if;

  loop
    v_code := public.generate_join_code();
    exit when not exists (select 1 from public.teams t where t.join_code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 25 then
      raise exception 'Could not allocate a join code' using errcode = '55000';
    end if;
  end loop;

  update public.teams set join_code = v_code where id = p_team_id;
  return v_code;
end;
$$;

-- A team must never be left without an owner.
-- NOTE: superseded twice below — see 20260803041823 (cascade handling) and
-- 20260803041902 (SECURITY DEFINER). Kept here as the original history.
create or replace function public.guard_last_owner()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_team_id uuid := coalesce(old.team_id, new.team_id);
  v_owners  int;
begin
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

create trigger team_members_guard_last_owner
  before update or delete on public.team_members
  for each row execute function public.guard_last_owner();

revoke all on function public.generate_join_code() from anon, authenticated;
grant execute on function public.create_team(text)      to authenticated;
grant execute on function public.join_team(text)        to authenticated;
grant execute on function public.rotate_join_code(uuid) to authenticated;
