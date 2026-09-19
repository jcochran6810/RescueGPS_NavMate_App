-- A teammate's waypoint photograph could never be read. One wrong column.
--
-- The team half of the read policy was:
--
--     exists (select 1 from waypoints w
--             where w.id::text = (storage.foldername(w.name))[2]
--               and w.team_id is not null
--               and navmate_is_team_member(w.team_id))
--
-- `storage.foldername(w.name)` is the **waypoint's own name** — "Marker 12",
-- the title a crew types — not the storage object's path. Inside that
-- sub-select the bare `name` resolves to the inner `waypoints` row and
-- shadows `storage.objects.name`, which is what the author meant and what the
-- comparison needs. A title has no path separators, so `[2]` is null, the
-- comparison is null, the EXISTS is false for every row, and the policy
-- collapsed to "your own photographs only".
--
-- The effect in the field: a crew member photographs a piece of debris, saves
-- it to the team, and everyone else sees a waypoint with a photograph they
-- cannot open. Nothing in the app reported it, because a signed-URL request
-- for an object RLS hides comes back as an ordinary "not found".
--
-- Objects are stored at `<user id>/<waypoint id>/<file>.jpg`, so `[1]` is the
-- owner and `[2]` is the waypoint — which is what makes the fixed form
-- correct, and it is asserted rather than assumed in the verification for
-- this migration.
drop policy if exists "navmate photos: read own or team-shared" on storage.objects;
create policy "navmate photos: read own or team-shared"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'waypoint-photos'
    and (
      (storage.foldername(objects.name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.waypoints w
        where w.id::text = (storage.foldername(objects.name))[2]
          and w.team_id is not null
          and public.navmate_is_team_member(w.team_id)
      )
    )
  );
