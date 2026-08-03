# Fix list

Outstanding fixes, TODOs, and known issues for RescueGPS NavMate.

Add new items at the top. Use the format:

- [ ] YYYY-MM-DD — short description (file_path:line if relevant)

## Open

- [ ] 2026-08-03 — Decide whether commits need to be GPG/SSH-signed. All
      commits so far are unsigned and show as Unverified on GitHub (the
      author email is correct; only the signature is missing). Fixing it
      needs a signing key in the environment that makes the commits;
      retrofitting existing commits means rewriting history, so this gets
      more expensive the longer it waits.
- [ ] 2026-08-03 — Deploy to Vercel. The MCP deploy returned `403 "You don't
      have permission to create a project."`; the connected token can read
      projects but not create them. Import the repo at https://vercel.com/new
      (see DEPLOYMENT.md).
- [ ] 2026-08-03 — Attach `rescuegps.stationinsight.com` to the new Vercel
      project. The domain is already in the team on the `bunker-gear` project,
      so DNS should configure automatically. Do NOT add it to `bunker-gear`.
- [ ] 2026-08-03 — Set Supabase Auth Site URL / Redirect URLs to the subdomain,
      or confirmation and password-reset emails will link to the wrong host.
- [ ] 2026-08-03 — Decide whether "Confirm email" stays on in Supabase Auth,
      and set up custom SMTP if it does (the built-in sender is rate-limited
      and not for production).
- [ ] 2026-08-03 — Rename the Supabase project from `plan-review-repeat` to
      `RescueGPS NavMate` (dashboard only; the management API cannot do it).
- [ ] 2026-08-03 — Exercise the signed-in flow in a real browser: signup, team
      create/join, waypoint sync, photo upload. Never run end-to-end — the
      build sandbox blocks outbound traffic to `*.supabase.co`.
- [ ] 2026-08-03 — Photos require a connection at save time. Waypoints saved
      offline sync later but drop their photos; the UI says so, but queuing the
      upload would be better (src/store/useWaypoints.ts).
- [ ] 2026-08-03 — No map view. The offline tile story is the hard part and is
      why it wasn't rushed into the first pass.

## Done

_(none yet)_
