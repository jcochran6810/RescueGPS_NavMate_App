# Fix list

Outstanding fixes, TODOs, and known issues for NavMate.

Add new items at the top. Use the format:

- [ ] YYYY-MM-DD — short description (file_path:line if relevant)

## Open

- [ ] 2026-09-13 — **Move the two domains, then set the Supabase Auth URLs.**
      Neither has an MCP tool — both are dashboards. Order matters, because a
      domain can only be on one Vercel project at a time:
      (1) add `navmate.stationinsight.com` to `rescuegps-navmate`
      (`prj_QkHXnAngwdCSZwz1S0qAVeDNPvJT`) and confirm it serves NavMate;
      (2) remove `rescuegps.stationinsight.com` from `rescuegps-navmate`;
      (3) add `rescuegps.stationinsight.com` to `rescuegps-navigator-pro`
      (`prj_KEOHsBii7KDFIGEYjBMrF0ACWmpu`), which currently has no custom
      domain. Then Auth → URL Configuration: **Site URL
      `https://rescuegps.stationinsight.com`** (the command system has no
      explicit redirect and depends on the fallback; NavMate always sends its
      own origin, so it does not care), and allow-list the bare origin *and*
      `/**` for **both** hosts. Leaving `navmate.stationinsight.com` off that
      list is the trap: an un-allow-listed redirect is silently replaced with
      the Site URL, so a crew member resetting a password in NavMate would land
      in the command dashboard. Also still worth checking: whether "Confirm
      email" is on, and whether the sender is custom SMTP rather than the
      rate-limited built-in. Full detail in `DEPLOYMENT.md`.
- [ ] 2026-09-13 — **Retire the moved-address banner** once everyone has
      reinstalled. `src/components/MovedNotice.tsx` renders only when the app
      is served from `rescuegps.stationinsight.com`, so it retires itself for
      each person the moment they reinstall — but once that address belongs to
      the command system, NavMate is never served from it at all and the
      component is dead code. Delete it and its two call sites in
      `src/App.tsx` after the handover has settled.
- [ ] 2026-09-13 — **A NavMate incident is readable by every signed-in user on
      the project.** The command system's `"Org-scoped incidents read
      (transitional)"` policy returns true whenever `organization_id is null`,
      which is how NavMate creates one — so its team scoping is advisory on
      read, not enforced. Same shape as the `profiles` item above and the same
      answer: it is the command system's policy and its posture to change
      (the name says "transitional"), NavMate does not rely on it, and
      tightening it would not break anything here. Worth doing before more than
      one department is on the database.
- [ ] 2026-09-13 — **Command-created incidents are invisible to NavMate**, by
      design for now: the load filters on `client_id is not null`
      (`src/store/useIncidents.ts`) so the field app lists only incidents it
      created and has a UI for. The reverse direction — a crew seeing an
      incident command opened and joining it — needs a join flow NavMate does
      not have, and the command system already has `join_requests` and
      `incident_participants` for exactly that. The next piece of the tie-in,
      when it is wanted.
- [ ] 2026-09-13 — **Not NavMate's, but worth telling whoever owns the command
      repo:** `frontend/src/config/config.js` defaults `SUPABASE_URL` to
      `https://grcsrldrkryrfjsildej.supabase.co`, a project ref that is not in
      the Supabase org at all. The client that matters
      (`frontend/src/services/supabase.js`) reads `import.meta.env` with no
      fallback and goes `null` — "running in local/demo mode" — when the
      variable is missing, so the deployment must be setting
      `VITE_SUPABASE_URL` to `ekhvfypxuxskjglwwoqh`. Worth confirming in the
      Vercel env vars and deleting the stale default before it misleads
      someone. Its `tiles.noaaCharts` also still points at
      `tileservice.charts.noaa.gov`, the NOAA raster service that has been shut
      down.
- [ ] 2026-09-13 — **Every signed-in user can read every row of `profiles` on
      this project.** The command system's own policy, `"Authenticated users
      can view all profiles"`, predates NavMate and was verified still in force
      (a NavMate crew member read all 5 profile rows in the access checks).
      That table carries `push_token_fcm`, `push_token_apns`,
      `emergency_contact_name`, `emergency_contact_phone` and
      `clearance_level`. Adding NavMate accounts to this project therefore
      widens who can read them. NavMate itself does **not** rely on that policy
      — teammate names come from `navmate_team_profiles()`, which returns
      id/full_name/call_sign and nothing else — so the policy can be tightened
      to the command system's real need without breaking NavMate. Worth doing
      before crew accounts outnumber command accounts.
- [ ] 2026-09-13 — Leaked-password protection is disabled on the RescueGPS
      project (Supabase Auth can check new passwords against
      HaveIBeenPwned). One toggle in the dashboard.
- [ ] 2026-09-13 — `admin_metrics()` and `admin_list_users()` count and list
      **both** applications' users, because `auth.users` is shared. Correct
      while one person administers both; if that stops being true, they need an
      "is a NavMate user" predicate (a row in `team_members`, probably).
- [ ] 2026-09-13 — The NavMate accounts on the new project
      (`cochranlawncare@gmail.com`, `jason.cochran@universalhazard.com`) are
      the command system's existing logins — they already existed there, so
      nothing was created and **their passwords were not touched**. If the
      NavMate passwords from the old project were different, they are gone with
      that project; use the command-system passwords or reset from the app.

- [ ] 2026-09-13 — **Exercise the chart plotter's NOAA services in a real
      browser.** Same wall as the tides and the imagery: the build sandbox's
      proxy 403s `gis.charttools.noaa.gov`, `encdirect.noaa.gov` and
      `tiles.openseamap.org`, so every one of them was stubbed. What is
      confirmed: the EPSG:3857 tile bbox against independently computed
      Mercator metres, the GetMap parameter shape, layer matching against a
      captured `MapServer/layers?f=json` payload, `exceededTransferLimit`
      quadrant splitting, GeoJSON *and* Esri JSON geometry parsing, and a
      31-check headless drive of the production build (tap-to-pick, a route
      round a stubbed bar at 2.94 NM against 2.40 NM direct, legs, ETA,
      steering, save-as-waypoints, and a dead ENC service degrading to a
      warned straight line). What is **not** confirmed:
      - that the NCDS WMS answers those exact GetMap parameters, and which
        `layers=` list is right (currently `0,1,2,3,4,5,6,7` — if the chart
        comes back blank or wrong, `GetCapabilities` is the thing to read);
      - that ENC Direct's layer names match the patterns in
        `ROLE_PATTERNS` (`src/lib/chart.ts`) for every usage band, and that
        `enc_approach` exists under that name;
      - that `DRVAL1` is the field name in every band;
      - whether any of the three hosts send `Access-Control-Allow-Origin`.
        All three are set `crossOrigin: false` and the SW rule accepts opaque
        responses (`statuses: [0, 200]`), so tiles should draw either way —
        but the ENC **queries** are `fetch`, and those genuinely need CORS. If
        the plotter says "no charted depths" everywhere with CORS errors in the
        console, that is the cause, and it needs a proxy this app does not
        have.
- [ ] 2026-09-13 — Measure the route plot on a real phone. A 114 000-cell grid
      (rasterise + chamfer + A* + string-pull) runs in ~60 ms in the test
      suite on this machine, which is why `src/lib/routing.ts` runs inline
      rather than in a Web Worker. If a mid-range phone hitches noticeably on
      **Plot course**, moving `planRoute` into a worker is a contained change.
- [ ] 2026-09-13 — The chart plotter's offline story is **untested**, because
      Playwright route stubs do not intercept service-worker fetches and the
      drive blocks SWs entirely. The `navmate-charts` CacheFirst rule
      (`vite.config.ts`) is what is supposed to make a saved area work with no
      signal; confirm in a real browser that re-plotting a route in an area
      already visited works with the network off. Related: there are now two
      tile caches sharing one device budget — see the storage item below.
- [ ] 2026-09-13 — **The marked-channel layers have never been seen for real.**
      `FAIRWY` (fairways) and `PILPNT` (piles) are matched by name at runtime
      like the existing eight roles, and are as unverified as those are — the
      proxy 403s `encdirect.noaa.gov`. If NOAA names its fairway layer
      something the pattern misses, the channel preference simply stays inert
      and the router behaves as it did before, which is the safe direction to
      fail (and is a tested requirement, not an assumption). Worth confirming
      the real names per usage band along with the item above. Also: piles are
      high-cardinality — a busy harbour can return thousands — so this may trip
      `exceededTransferLimit` and start showing the "chart query hit its limit"
      warning on routes that never showed it before. That is honest, not a
      regression, but it will look like one.
- [ ] 2026-09-13 — **The channel preference only sees inside the routing
      grid**, whose margin is `max(1 NM, 35% of the direct distance)` clamped
      to 20 NM (`MARGIN_FRACTION` in `src/lib/routing.ts`). A marked channel
      worth using that lies outside that box is invisible to the planner.
      Widening the margin changes `cellM` and therefore the geometry of every
      existing route, so it was deliberately not done inside the channel
      change.
- [ ] 2026-09-13 — **Measure the channel-aware plot on a real phone.** The
      penalty makes the octile heuristic weaker (it under-estimates by up to
      the penalty ratio where a channel is charted but the course runs outside
      it), so A* expands more. Saturation bounds it and `hasChannels`
      short-circuits the whole thing where nothing is marked — which is most
      of the coast — but the worst case is a box with a channel in one corner
      and a passage that ignores it. Same lever as before if it hitches:
      `MAX_SIDE`, or move `planRoute` into a worker.
- [ ] 2026-09-13 — `Segmented` in `src/components/ui.tsx` was extracted from
      **14 hand-rolled copies across 7 files** and is currently used only by
      the new code and the Chart tab. The copies in `TrackTab`, `AdminTab`,
      `SearchTab`, `EtaTab` and `DataTab` still set no `aria-pressed` and no
      group role, so their selected option is styled but never announced.
      Swapping them is mechanical; it was left out of the chart change because
      those screens have no browser coverage.
- [ ] 2026-09-13 — Bridges are read for air draft but do not yet block a
      route. `src/lib/chart.ts` matches the bridge layers and
      `clearsHeight()` in `src/lib/vessel.ts` does the comparison, but nothing
      wires a low span into the router as an obstruction. A boat with a real
      air draft can currently be routed under a bridge it does not fit under.

- [ ] 2026-08-06 — **Incident handoff to RescueGPS is export-only for now.**
      NavMate's `incidents` table mirrors rescuegps-navigator-pro's column
      names and CHECK lists (see the migration comment in
      `supabase/migrations/20260806150000_navmate_incidents.sql`), and the
      "Handoff to command" button exports the incident + LKP history + drift
      cards + clues in that system's exact table shapes. The live tie-in —
      command adopting a field incident over the wire — needs either the
      database merge (tracked below) or an import screen on the command
      side. The two databases are still separate projects.
- [ ] 2026-08-06 — Incident + search-pattern flows verified only against a
      stubbed backend (this sandbox blocks `*.supabase.co`, as ever). The
      stub now *accepts* writes and serves them back — which is how the
      synced-record-vanishes bug was found — but the real RLS on
      `incidents` (team member update, admin delete) has not been exercised
      with live accounts. Same bucket as the existing signed-in-flow item.

- [ ] 2026-08-06 — **Exercise the satellite imagery against the real Esri
      service in a browser.** The build sandbox's proxy 403s
      `server.arcgisonline.com`, exactly as it does NOAA, so every tile in
      this session's verification came from a stubbed 256 px PNG. What is
      confirmed: the tile arithmetic against independently computed Web
      Mercator values, that the app requests `{z}/{y}/{x}` row-before-column
      for the right tile, that tiles paint and decode, and that a dead
      imagery link degrades to a drawn track with a banner. What is not:
      that Esri serves those exact URLs with `Access-Control-Allow-Origin`
      (the `<img crossOrigin="anonymous">` in `src/lib/tiles.ts` assumes it —
      if imagery is blank in the field with CORS errors in the console, drop
      `crossOrigin` on `SATELLITE`/`LABELS` and accept opaque, quota-hungry
      cache entries), and that zoom 19 has coverage everywhere the crews work.
- [ ] 2026-08-06 — Decide how much imagery a device may keep. (Now two
      datasets: `navmate-imagery` at 2000 entries / 90 days and
      `navmate-charts` at 1500 / 30 days.) The service
      worker caches tiles for 90 days, capped at 2000 entries
      (`vite.config.ts`), which is roughly 40–60 MB at Esri's tile sizes;
      `purgeOnQuotaError` clears the lot if the device pushes back. There is
      no per-area management and no "how much am I holding" figure in the UI.
      Worth revisiting once someone has actually saved a few operating areas.

- [ ] 2026-08-06 — Tracking still stops when the app is not on screen. The
      tracker now takes a screen wake lock while running
      (`src/store/useTracker.ts`), which covers a phone left face-up in a
      pocket-free hand, but a browser tab that is backgrounded or a screen
      the user actively locks stops delivering fixes, and the track simply
      has a hole in it. A real fix means a background geolocation API no
      browser gives a web app; the honest alternatives are saying so in the
      UI (done — the tracker says when the screen is held awake) or an
      installed-PWA periodic sync, which does not give positions either.

- [ ] 2026-08-05 — **Confirm where the `planner` exposed-schema setting came
      from.** From ~20:30 to ~21:21 UTC today every REST request 503'd:
      the `authenticator` role had `pgrst.db_schemas = public,
      graphql_public, planner`, no `planner` schema exists, and PostgREST
      crash-looped on its schema cache (postgres logged `schema "planner"
      does not exist` every 32 s). Fixed by resetting the role setting to
      `public, graphql_public`. `planner` is a RescueGPS-side schema name —
      if it was added in Dashboard → Settings → API → "Exposed schemas",
      remove it there too or the dashboard may re-apply it; if a planner
      schema is actually wanted for the shared-database future, create the
      schema first, then expose it.

- [ ] 2026-08-05 — SAR record photos. `sar_records` (clues especially) has no
      photo path yet; the clue card tells the crew to stamp a waypoint for
      photographs. Wiring clues to the photo bucket needs a storage-policy
      change (the team-read policy joins `waypoints`, not `sar_records`).
- [ ] 2026-08-05 — Photos staged offline live in memory only (upload
      automatically on reconnect while the app stays open, and the UI says
      so). Surviving an app reload needs the IndexedDB item below.
- [ ] 2026-08-05 — An op the server refuses is now set aside after 3 attempts
      (visible, with Retry/Discard in the Data tab) instead of wedging the
      queue. A network-level 403 from a proxy/captive portal classifies as
      "refused" too — recoverable via Retry, but if it shows up in the field
      the classification in `src/lib/retry.ts` may need a PostgREST-code
      check.
- [ ] 2026-08-05 — When the RescueGPS and NavMate databases merge:
      `sar_records.team_id` maps to incident participation, `lon` to `lng`,
      and each `kind`'s payload projects onto `lkp_history` /
      `field_events` / `field_drift_data` / `weather_snapshots`. The
      migration comment in
      `supabase/migrations/20260805210000_navmate_sar_records.sql` documents
      the mapping.

- [ ] 2026-08-05 — The Supabase project is on a plan that **pauses when idle**,
      and the first request after a wake gets PostgREST's `PGRST002`
      ("Could not query the database for the schema cache. Retrying.") for
      anywhere up to a minute. The app now retries transient errors rather
      than surfacing that (`src/lib/retry.ts`), which covers the common case,
      but a crew opening the app cold at an incident should not be waiting on
      a cold start at all. Decide whether this project needs a plan that stays
      warm before anyone relies on it operationally.
- [x] 2026-08-05 — ~~There is a second Supabase project in the org named
      `rescuegps-production`… Confirm the other one is not wanted and delete
      it.~~ **RETRACTED 2026-09-13 — do not delete it.** That project is
      `ekhvfypxuxskjglwwoqh`, now named "RescueGPS", and it is the one NavMate
      and the command system both run on. The project this item told you to
      keep (`puzwcsrtqtbutypzozvu`) is the one that is no longer NavMate's.
- [ ] 2026-08-05 — Exercise the **NOAA tide calls in a real browser**. The build
      sandbox's proxy returns 403 for `api.tidesandcurrents.noaa.gov`, so the
      two live endpoints have never run: the station list and the hi/lo
      predictions. The parsers are unit-tested against the documented payload
      shapes and tolerate `lat`/`lng`/`lon` naming, but the field names in the
      real station feed are unconfirmed (`src/lib/tides.ts`). If the card says
      "Unexpected station list from NOAA", that is the thing to check first.
- [ ] 2026-08-05 — The tide station list is a **one-off ~1.5 MB download** on
      first use. It is cached for 30 days and makes nearest-station lookups
      work offline afterwards, but it is a poor first experience on a weak
      cellular link. A pre-slimmed list shipped in the bundle would fix it.
- [ ] 2026-08-05 — Compass headings are **magnetic, not true**, on both
      platforms, and the app says so rather than correcting them —
      declination needs the WMM model, which is too large to justify so far.
      (An earlier note here claimed iOS reports true north; Apple documents
      `webkitCompassHeading` as relative to magnetic north, and the label
      was corrected on 2026-08-05.) Decide whether the difference matters
      enough to carry the model.
- [ ] 2026-08-05 — Point the **GitHub default branch** at `main`. It is still
      `claude/rescuegps-subdomain-setup-gchtnn`, which is why the Vercel
      import picked that branch for production. Vercel is fixed; GitHub is
      not. Settings → Branches. Affects new clones, PR bases and any future
      import.
- [ ] 2026-08-05 — Verify the commit-signature claim before acting on it.
      Vercel's deployment metadata reports `90498e6` as
      `githubCommitVerification: "verified"`, which contradicts the
      2026-08-03 note below. Check the commit list in the GitHub UI; if they
      are verified, drop the item rather than retrofitting anything.
- [ ] 2026-08-03 — Decide whether commits need to be GPG/SSH-signed. Recorded
      as unsigned and Unverified on GitHub (author email correct, signature
      missing), but see the item above — that may not be true. Retrofitting
      means rewriting history, so it gets more expensive the longer it waits.
- [ ] 2026-08-03 — Decide whether "Confirm email" stays on in Supabase Auth,
      and set up custom SMTP if it does (the built-in sender is rate-limited
      and not for production).
- [ ] 2026-08-03 — Exercise the signed-in flow in a real browser: signup, team
      create/join, waypoint sync, photo upload. Never run end-to-end — the
      build sandbox blocks outbound traffic to `*.supabase.co`.
- [ ] 2026-08-03 — Photos still require a connection at save time. A waypoint
      can now have photos attached after the fact — from the stamp panel or
      from Edit on any waypoint — so nothing is lost by stamping offline and
      coming back. But the bytes themselves are never queued, because
      localStorage is not sized for photographs; the UI says so plainly.
      Queuing them properly needs IndexedDB (src/store/useWaypoints.ts).


## Done

- [x] 2026-09-13 — **The command system could not see NavMate's incidents.**
      Its dashboard subscribes to `incidents` to "detect new incidents from
      other users (e.g. field app)" while NavMate wrote `navmate_incidents`, so
      that subscription could never fire. Merged in migration
      `20260913041316`: `lkp_lat`/`lkp_lng` lost NOT NULL (NavMate opens an
      incident before the LKP is known), `client_id` and `team_id` were added,
      two additive RLS policies give NavMate team-member update and scoped
      delete, `sar_records.incident_id` was repointed and `navmate_incidents`
      dropped. Done at the only cheap moment — it held 0 rows and nothing
      referenced it. The command system's 4 incidents, its constraints, its
      triggers and its own policies were untouched; opening an incident in the
      field now also makes the crew member a participant and initial IC through
      their existing trigger.

- [x] 2026-08-03 — Attach a custom domain to the `rescuegps-navmate` Vercel
      project. Confirmed done on 2026-09-13 — it held
      `rescuegps.stationinsight.com`. **Superseded the same day:** that address
      was handed to the RescueGPS command system and NavMate moved to
      `navmate.stationinsight.com`. See the open item at the top for the
      handover order.

- [x] 2026-09-13 — **The NavMate database was gone.** The project the app
      compiled in (`puzwcsrtqtbutypzozvu`) had been repurposed into an
      unrelated notes app, taking every NavMate table and account with it;
      found when the vessels migration failed with `relation "public.teams"
      does not exist`. Resolved by re-homing NavMate onto
      `ekhvfypxuxskjglwwoqh` ("RescueGPS"), alongside the command system:
      three `navmate_rehome_*` migrations plus `navmate_vessels`, all applied
      and verified (command side untouched — `incidents` still 4 rows,
      `asset_tracks` 26, their `handle_new_user` intact). Note the project
      rename alone did **not** carry the schema across; it had to be built.

- [x] 2026-08-06 — No map view. Live tracking now draws on Esri World Imagery
      (`src/components/SatelliteMap.tsx`), with the north-up plot kept as the
      `Plot only` view that fetches nothing. The offline story that held this
      up: tiles are cached by the service worker cache-first, and the map has
      a button that pulls the surrounding area down before the signal goes.
      See the open item above for what is still unverified against the live
      service.

- [x] 2026-08-05 — Rename the Supabase project from `plan-review-repeat` to
      `RescueGPS NavMate`. Confirmed done — the management API reports the
      project name as `RescueGPS NavMate`.

- [x] 2026-08-03 — Deploy to Vercel. Project `rescuegps-navmate`
      (`prj_QkHXnAngwdCSZwz1S0qAVeDNPvJT`) was created by the user from the
      GitHub import on 2026-08-05. The 403 was a token permission limit and
      still applies to sessions here — project creation stays manual.
- [x] 2026-08-05 — Set the Vercel production branch to `main`. Note it lives
      under Settings → **Environments** → Production, not Settings → Git;
      DEPLOYMENT.md's path was out of date.
