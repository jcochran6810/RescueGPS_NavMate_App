-- Integration contract v1 — N3 (C5, C8): the command system can read what a
-- crew collects for an incident, and both apps get it live.
-- Uses RescueGPS's integ_can_read_incident() (R2) — never a local copy.
-- The existing owner / team policies stay; these are additional.

drop policy if exists "integ: incident readers read waypoints" on public.waypoints;
create policy "integ: incident readers read waypoints" on public.waypoints
  for select to authenticated
  using (incident_id is not null and public.integ_can_read_incident(incident_id));

drop policy if exists "integ: incident readers read records" on public.sar_records;
create policy "integ: incident readers read records" on public.sar_records
  for select to authenticated
  using (incident_id is not null and public.integ_can_read_incident(incident_id));

-- A boat is readable once it is registered as a unit on an incident the
-- reader can see (resources.vessel_id, R4).
drop policy if exists "integ: incident readers read unit vessels" on public.vessels;
create policy "integ: incident readers read unit vessels" on public.vessels
  for select to authenticated
  using (exists (
    select 1 from public.resources r
     where r.vessel_id = vessels.id
       and r.incident_id is not null
       and public.integ_can_read_incident(r.incident_id)
  ));

do $$
declare t text;
begin
  foreach t in array array['waypoints', 'sar_records', 'vessels'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
