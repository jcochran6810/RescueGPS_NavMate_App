-- Integration contract v1 — N11: a clue photograph can be opened by the
-- people who can see the clue, not only the person who took it.
--
-- Clue photos live in the waypoint-photos bucket at
-- `<user id>/<sar_records.id>/<file>`. The existing read policy only matches
-- the second path segment against waypoints.id, so a SAR record's photo was
-- readable by its author alone. This adds a read path for:
--   * the record's team (same rule as its row), and
--   * anyone who can read the record's incident (RescueGPS integ_can_read_incident),
-- and extends the incident rule to waypoint photos, since a waypoint dropped
-- during an incident is now readable by command (N3).
--
-- The check lives in a SECURITY DEFINER function taking the object name, so
-- the column cannot be shadowed by a same-named column inside a sub-select —
-- the bug that once hid every teammate's waypoint photo.

create or replace function public.navmate_can_read_field_photo(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with seg as (
    select (storage.foldername(p_object_name))[2] as id_text
  )
  select exists (
    select 1
      from seg
      join public.sar_records r on r.id::text = seg.id_text
     where r.deleted_at is null
       and (
         r.user_id = auth.uid()
         or (r.team_id is not null and public.navmate_is_team_member(r.team_id))
         or (r.incident_id is not null and public.integ_can_read_incident(r.incident_id))
       )
  )
  or exists (
    select 1
      from seg
      join public.waypoints w on w.id::text = seg.id_text
     where w.deleted_at is null
       and w.incident_id is not null
       and public.integ_can_read_incident(w.incident_id)
  );
$$;
revoke all on function public.navmate_can_read_field_photo(text) from public, anon;
grant execute on function public.navmate_can_read_field_photo(text) to authenticated;

drop policy if exists "navmate photos: read clue and incident photos" on storage.objects;
create policy "navmate photos: read clue and incident photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'waypoint-photos' and public.navmate_can_read_field_photo(name));
