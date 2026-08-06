# Fix list

Outstanding fixes, TODOs, and known issues for RescueGPS NavMate.

Add new items at the top. Use the format:

- [ ] YYYY-MM-DD — short description (file_path:line if relevant)

## Open

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
- [ ] 2026-08-06 — Decide how much imagery a device may keep. The service
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
- [ ] 2026-08-05 — There is a second Supabase project in the org named
      `rescuegps-production` (`ekhvfypxuxskjglwwoqh`, created 2025-12-28). The
      app points at `puzwcsrtqtbutypzozvu` ("RescueGPS NavMate"), which is the
      one carrying the schema and the live account. Confirm the other one is
      not wanted and delete it, or the name will mislead someone later.
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
- [ ] 2026-08-03 — Attach `rescuegps.stationinsight.com` to the
      `rescuegps-navmate` Vercel project (Settings → Domains). The domain is
      already in the team on the `bunker-gear` project, so DNS should
      configure automatically. Do NOT add it to `bunker-gear`.
- [ ] 2026-08-03 — Set Supabase Auth Site URL / Redirect URLs to the subdomain,
      or confirmation and password-reset emails will link to the wrong host.
      Site URL `https://rescuegps.stationinsight.com`; allow-list both the
      bare origin and `/**`, because the app sends
      `window.location.origin` (no trailing slash) as its redirect. There is
      no MCP tool for this — dashboard or Management API only.
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
