# Fix list

Outstanding fixes, TODOs, and known issues for RescueGPS NavMate.

Add new items at the top. Use the format:

- [ ] YYYY-MM-DD — short description (file_path:line if relevant)

## Open

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
- [ ] 2026-08-05 — Compass headings from Android's
      `deviceorientationabsolute` are **magnetic, not true**, and the app says
      so rather than correcting them — declination needs the WMM model, which
      is too large to justify so far. iOS reports true north. Decide whether
      the difference matters enough to carry the model.
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
- [ ] 2026-08-03 — Rename the Supabase project from `plan-review-repeat` to
      `RescueGPS NavMate` (dashboard only; the management API cannot do it).
- [ ] 2026-08-03 — Exercise the signed-in flow in a real browser: signup, team
      create/join, waypoint sync, photo upload. Never run end-to-end — the
      build sandbox blocks outbound traffic to `*.supabase.co`.
- [ ] 2026-08-03 — Photos still require a connection at save time. A waypoint
      can now have photos attached after the fact — from the stamp panel or
      from Edit on any waypoint — so nothing is lost by stamping offline and
      coming back. But the bytes themselves are never queued, because
      localStorage is not sized for photographs; the UI says so plainly.
      Queuing them properly needs IndexedDB (src/store/useWaypoints.ts).
- [ ] 2026-08-03 — No map view. The Track tab now plots the recorded path
      north-up to scale with waypoints marked, which covers "show me where I
      have been", but there is still no basemap under it. The offline tile
      story is the hard part and is why it wasn't rushed into the first pass.

## Done

- [x] 2026-08-03 — Deploy to Vercel. Project `rescuegps-navmate`
      (`prj_QkHXnAngwdCSZwz1S0qAVeDNPvJT`) was created by the user from the
      GitHub import on 2026-08-05. The 403 was a token permission limit and
      still applies to sessions here — project creation stays manual.
- [x] 2026-08-05 — Set the Vercel production branch to `main`. Note it lives
      under Settings → **Environments** → Production, not Settings → Git;
      DEPLOYMENT.md's path was out of date.
