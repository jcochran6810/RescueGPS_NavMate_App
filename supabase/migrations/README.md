# NavMate migrations

Two eras live in this directory, and they are not interchangeable.

## `20260803*` – `20260806*` — the original project (HISTORY ONLY)

These built NavMate on Supabase project `puzwcsrtqtbutypzozvu`, which no longer
holds NavMate: it was repurposed into an unrelated app in September 2026,
taking the schema and the accounts with it.

**Do not replay these against the current database.** They were written for an
empty project and are actively dangerous here:

- `20260803040156` opens with `drop table if exists public.waypoints cascade`,
  then `create table public.profiles`, which errors with "relation already
  exists" and aborts the rest of the file.
- the same file does `create or replace function public.handle_new_user()`.
  That name belongs to the RescueGPS command system's signup trigger on this
  database. `create or replace` does not error — it would silently replace
  their profile-creation logic with NavMate's.
- `touch_updated_at`, `is_team_member`, `is_team_admin` and
  `is_platform_admin` are `create or replace` too, and all are names a second
  application could plausibly own.
- `20260806150000` creates `public.incidents`, which already exists here with a
  different, much larger shape and live rows.

They are kept because they are the record of how NavMate's schema was arrived
at, and the comments in them explain decisions the current schema still
carries.

## `20260913*` — the RescueGPS database (CURRENT)

`navmate_rehome_core`, `navmate_rehome_incidents_sar_rpcs`,
`navmate_rehome_admin_storage_grants` and `navmate_vessels` build NavMate on
project `ekhvfypxuxskjglwwoqh` ("RescueGPS"), alongside the command system.
These are the files that match the live database, and the ones to run on a
fresh one, in filename order.

What they do differently, and why:

- **`profiles` is reused, never created**, and nothing alters it, adds a policy
  to it, or touches its trigger. NavMate's `callsign` is this database's
  `call_sign`; the application was changed to match rather than a duplicate
  column being added. The command system's trigger already fills
  id/email/full_name from signup metadata, which is what NavMate sends.
- **Every NavMate-internal helper is prefixed `navmate_`** —
  `navmate_touch_updated_at`, `navmate_is_team_member`,
  `navmate_is_team_admin`, `navmate_is_platform_admin`,
  `navmate_guard_last_owner`, `navmate_generate_join_code`. They are only
  called from NavMate's own policies, so the prefix costs nothing and removes
  the silent-overwrite hazard permanently in both directions.
- **NavMate's incidents were merged into the command system's `incidents`**
  by `20260913041316`. That table was briefly `navmate_incidents`; it now holds
  0 rows and is gone. The merge is what makes the command dashboard's
  `subscribeToAllIncidents` — written to "detect new incidents from other users
  (e.g. field app)" — actually fire. `client_id` separates the two systems'
  rows and `team_id` carries NavMate's scope; `lkp_lat`/`lkp_lng` lost NOT NULL
  because NavMate opens an incident before the LKP is known.
- **Reading a teammate's name goes through `navmate_team_profiles()`**, a
  SECURITY DEFINER function returning only id/full_name/call_sign, rather than
  a NavMate read policy on `profiles`. RLS is row-level: a policy would have
  handed NavMate crews the command system's push tokens, emergency contacts
  and clearance levels for those same rows.
- **Tables are created before functions**, because a SQL function body is
  validated against the tables it names at creation time.

`anon` has no policy on any NavMate table, here as everywhere.

## `20260924*` and later — the integration contract with RescueGPS

`20260924*_integ_nav_*` are NavMate's half of the integration contract
(waypoint `incident_id`, soft deletes, command read policies, clue-photo
read). The command system's half lives in its own repository
(`rescuegps-navigator-pro/database/integration/integ_rgps_*.sql`); both are
applied here.

`20261002000000_navmate_integ_team_join_rejoin` (applied 2026-10-02) changes
two NavMate functions found wrong by running the two-way flows as real
accounts: a team member now joins their own team's incident directly
(everything command sends is read by participation, and only the creator was
a participant), re-joining after leaving works (the old re-activation tripped
the command system's participant guard), and `is_field_created` no longer
reads `client_id is not null`, which the command wizard now also writes.
