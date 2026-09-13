-- Merge NavMate's incidents into the command system's `incidents` table.
--
-- WHY
--
-- The command dashboard subscribes to `incidents` specifically to "detect new
-- incidents from other users (e.g. field app)" — its own comment. NavMate was
-- writing `navmate_incidents`, so that subscription could never fire and
-- "RescueGPS ties everything together" was not true of the one object that
-- matters most. One table fixes it.
--
-- This is safe to do now and would not have been later: `navmate_incidents`
-- holds 0 rows and no `sar_records` reference it, so nothing is migrated and
-- nothing is lost.
--
-- WHAT MADE IT POSSIBLE
--
-- NavMate's incident table was built to mirror this one deliberately — the 22
-- `incident_type` codes and 9 `status` values are identical, so no value has to
-- be translated. The remaining gaps are all additive:
--
--   * `client_id` — NavMate's offline-sync idempotency key. Nullable, so the
--     command system's existing rows and its own future inserts are unaffected;
--     it is also the discriminator NavMate uses to list only its own incidents
--     rather than adopting command-created ones it has no UI for.
--   * `team_id` — NavMate scopes by team where the command system scopes by
--     organisation and participant. Nullable and ignored by the command side.
--   * `lkp_lat` / `lkp_lng` lose NOT NULL. NavMate opens an incident before the
--     LKP is known — "incident first, LKP second" is a deliberate decision
--     recorded in its own session log, because that is the real field order.
--     The command system always supplies both, so nothing changes for it, and
--     its `update_incident_location` trigger already tolerates nulls
--     (ST_MakePoint of a null returns a null geometry rather than erroring).
--
-- Three of its triggers do useful work for a NavMate incident and are left
-- exactly as they are: `generate_incident_number` only fills a blank number, so
-- NavMate's own offline-generated one survives; `tf_incidents_add_creator_
-- participant` makes the field crew a participant automatically; and
-- `tf_incidents_set_initial_ic` makes them the initial IC — which is the right
-- semantics for a unit that is first on scene until command arrives.

alter table public.incidents alter column lkp_lat drop not null;
alter table public.incidents alter column lkp_lng drop not null;

alter table public.incidents add column client_id text;
alter table public.incidents add constraint incidents_client_id_key unique (client_id);

alter table public.incidents add column team_id uuid references public.teams(id) on delete set null;
create index incidents_team_id_idx on public.incidents(team_id) where team_id is not null;
create index incidents_client_id_idx on public.incidents(client_id) where client_id is not null;

comment on column public.incidents.client_id is
  'NavMate offline-sync idempotency key. NULL on command-created incidents; NavMate lists only rows where this is set.';
comment on column public.incidents.team_id is
  'NavMate team scope. NULL on command-created incidents, which scope by organisation and participant instead.';

-- RLS: additive only. Policies are OR'd, so these widen NavMate's access
-- without narrowing or altering anything the command system already relies on.
--
-- SELECT needs nothing: the existing "Org-scoped incidents read (transitional)"
-- policy already returns true when organization_id is null, which is how a
-- NavMate incident is created. That is broader than NavMate's own team scoping
-- — see fix_list.md — but it is the command system's existing posture and
-- narrowing it is their decision, not this migration's.

-- The command system's update policy is IC / creator / commander only. NavMate
-- lets any team member update the shared incident, because the unit closing a
-- search is rarely the one that opened it.
create policy "navmate: team members update"
  on public.incidents for update
  to authenticated
  using (team_id is not null and public.navmate_is_team_member(team_id))
  with check (team_id is not null and public.navmate_is_team_member(team_id));

-- The command system has no DELETE policy at all, so nobody can delete
-- anything. This grants it for NavMate-scoped rows only: a command-created
-- incident has team_id null and stays undeletable.
create policy "navmate: delete own or as team admin"
  on public.incidents for delete
  to authenticated
  using (
    team_id is not null
    and (created_by = (select auth.uid()) or public.navmate_is_team_admin(team_id))
  );

-- Point the datum records at the surviving table. SET NULL, not CASCADE: what a
-- crew observed outlives an incident opened by mistake and deleted.
alter table public.sar_records drop constraint sar_records_incident_id_fkey;
alter table public.sar_records
  add constraint sar_records_incident_id_fkey
  foreign key (incident_id) references public.incidents(id) on delete set null;

drop table public.navmate_incidents;
