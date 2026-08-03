-- Waypoint photos live in Storage, not inline in the row. The prototype stored
-- base64 data URLs in jsonb, which makes rows enormous and sync unusable in the
-- field. `waypoints.photos` now holds an array of object paths.
--
-- Path convention: {user_id}/{waypoint_id}/{file}

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'waypoint-photos', 'waypoint-photos', false, 10485760,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "photos: upload into own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'waypoint-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "photos: read own or team-shared" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'waypoint-photos'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.waypoints w
        where w.id::text = (storage.foldername(name))[2]
          and w.team_id is not null
          and public.is_team_member(w.team_id)
      )
    )
  );

create policy "photos: delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'waypoint-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
