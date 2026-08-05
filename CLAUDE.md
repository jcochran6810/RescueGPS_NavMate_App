# CLAUDE.md

Project-specific instructions for Claude Code when working on this repository.

RescueGPS NavMate is a static single-page app (Vite + React 19 + TypeScript)
backed by Supabase, served at `rescuegps.stationinsight.com`. It shares a
parent domain with Station Insight and nothing else — separate repo, separate
hosting project, separate database.

## Branch model

- `main` is the **release branch**. Once the Vercel project is connected to
  this repo, every push to `main` auto-deploys to the live subdomain.
- Claude Code sessions work on a per-session branch (e.g. `claude/<slug>`).
- Session branches are **drafts**. They never deploy. They only affect the
  live site after the end-session protocol below merges them into `main`.
- Treat `main` as the source of truth at the start of every session — never
  carry stale branch state forward.

## Start-session protocol (run on EVERY new session)

**Hard rule:** every new session MUST begin with the working branch at
`origin/main` HEAD. No session may start from a stale branch, a forked
commit, or anything other than the most recent `origin/main`. This is
non-negotiable — it prevents the "I never saw that feature" problem
where the session forks off an old commit and ships duplicates or
regressions of work already on main.

The SessionStart hook enforces this automatically. If it can't (dirty
tree, branch ahead of main on resume, fetch failure, etc.), the
assistant **must stop and surface the drift to the user before doing
any other work** — see "Turn-1 verification" below.

### Web sessions (Claude Code on the web): AUTOMATED

A SessionStart hook (`.claude/hooks/session-start.sh`, registered in
`.claude/settings.json`) runs automatically and:

1. Injects the "read CLAUDE.md / README.md / fix_list.md first" policy into
   the session's `additionalContext`. Auto-creates a stub `fix_list.md` if
   missing (never overwrites).
2. Syncs the working branch to `origin/main` (fetch + `git reset --hard`)
   per the policy below:
   - **`source=startup`**: always reset to `origin/main`, even if the
     branch is ahead. Fresh sessions never inherit forked state — any
     ahead commits remain in `git reflog <branch>` if needed.
   - **`source=resume`/`compact`/`clear`**: only auto-syncs when it's a
     pure fast-forward (no commits ahead of `origin/main`). If the
     branch has session-in-progress commits ahead, the hook emits a
     **BLOCKER** instead of destroying that work, and the assistant
     must surface the drift to the user.
   - **Skipped (BLOCKER emitted)** when: on `main` itself, detached
     HEAD, `origin/main` does not exist, or `git fetch` fails. In each
     case the assistant must stop and resolve before any other work.
   - **Dirty working tree**: sync is always skipped (never auto-reset
     over uncommitted work). It emits a BLOCKER on `source=startup`, or
     whenever the branch is also behind `origin/main` — both mean the
     session is not starting from a known state. On
     `resume`/`compact`/`clear` at `origin/main` HEAD it emits a warning
     instead, because uncommitted work is the normal mid-session case
     and stopping there would be noise.
3. Runs `npm install`, `npm run typecheck`, `npm run lint`, and `npm test`
   so the assistant has a known-good baseline before turn 1.
4. Extracts the most recent `## Session log` entry from CLAUDE.md so the
   assistant sees what the previous session shipped.
5. Emits a single summary (policy + sync status + check results + previous
   session entry) into `additionalContext`. When sync was blocked, the
   payload begins with `⛔ SESSION-START BLOCKER`.

### Local sessions (or web fallback): MANUAL

If you're working locally, or the hook didn't run for any reason, do the
same steps by hand BEFORE any other work:

1. `git fetch origin --prune`
2. `git checkout <working-branch>` (create from `origin/main` if it doesn't
   exist yet — **never create a branch from an older commit**)
3. Get to `origin/main` HEAD:
   - If the branch has no commits ahead of `origin/main`:
     `git reset --hard origin/main` (or `git merge --ff-only origin/main`).
   - If it has session work ahead and you want to keep it:
     `git merge --no-ff origin/main` and resolve conflicts.
   - If the ahead commits are stale and unwanted:
     `git reset --hard origin/main` (verify reflog has a backup first).
4. Run `npm install`, `npm run typecheck`, `npm run lint`, and `npm test` to
   confirm the baseline is healthy. Fix anything broken before adding new work.

### Turn-1 verification (assistant MUST perform on every session)

Even with the hook in place, on the first turn of every session the
assistant verifies the branch is at `origin/main` HEAD before doing any
real work:

1. Read the `additionalContext` injected by the SessionStart hook. If it
   begins with `⛔ SESSION-START BLOCKER`, **stop immediately**, relay the
   sync status to the user, and ask how to proceed (commit/stash, merge
   origin/main in, or hard reset). Do not start the task.
2. If no hook context is present (local session, hook crashed, etc.),
   manually run:
   ```
   git fetch origin --prune
   git rev-list --count HEAD..origin/main   # commits behind main
   git rev-list --count origin/main..HEAD   # commits ahead of main
   git status --porcelain                   # dirty tree?
   ```
   If behind > 0 or ahead > 0: stop and surface to the user. If the tree
   is merely dirty at `origin/main` HEAD and this is a resumed session,
   that's in-progress work — note it and carry on. Otherwise stop. Only
   proceed once the branch is at `origin/main` HEAD (or the user has
   explicitly directed otherwise for this session).
3. Only after the branch state is confirmed at `origin/main` HEAD may the
   assistant begin the user's task.

This is the safety net that catches everything the hook can't auto-fix.

## End-session protocol (run on EVERY "end session")

When the user types **"end session"** (or a clear equivalent — "wrap up",
"merge this", "ship it", etc.), the goal is to land everything on `main`.
**This is non-negotiable** — every session must end with the working
branch merged into `main` and pushed. Do the following in order:

1. **Commit any uncommitted work** on the working branch first, with a
   descriptive message. No exceptions — no "I'll get to it later" stashes.

2. **Update the `## Session log` section** of this file with a dated entry
   summarizing every meaningful change made during the session:
   ```
   ### YYYY-MM-DD — <branch name>
   - bullet for each meaningful change
   - group by feature / fix / docs where it helps
   - reference key files added/modified when useful
   ```
   Append newest-first.

3. **Commit the CLAUDE.md update** to the working branch with a message
   like `Update CLAUDE.md with session log`.

4. **Push the working branch** to origin so it's safe before the merge:
   `git push -u origin <working-branch>`.

5. **Merge the working branch into `main`**:
   - `git fetch origin --prune`
   - `git checkout main`
   - `git pull --ff-only origin main`
   - `git merge --no-ff <working-branch>` (preserve history with a merge
     commit; the merge commit message should be
     `Merge <working-branch> into main — <one-line summary>`)
   - Resolve any conflicts thoughtfully — keep both sides where they don't
     actually overlap. If a conflict is genuinely ambiguous, **stop and
     surface it to the user** before continuing.
   - Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
     on `main` after the merge to confirm nothing broke. Fix anything that did.
   - `git push origin main`

6. **Switch back to the working branch** so the user can keep iterating if
   they want: `git checkout <working-branch>`.

7. **Confirm to the user** with the merged commit hash and a one-sentence
   summary of what landed.

**Rules:**
- Do **not** delete the working branch after merge — keep it for reference.
- Do **not** skip the merge to main, even if the session was "just a quick
  fix". A branch that never merges turns into the "lost session" problem.
- Do **not** force-push to main. If main has new commits while you were
  working, pull them in (step 5's `git pull --ff-only`) and re-attempt the
  merge.
- If the user explicitly says "don't merge yet" (e.g. they want to open a
  PR for review), respect that — but still commit + push the working
  branch + update the session log + remind them the merge is pending.

## Project specifics

### Commands

| | |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b` then `vite build` (runs `prebuild` icon generation first) |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run lint` | ESLint (flat config in `eslint.config.js`) |
| `npm test` | Vitest, single run |

### Layout

```
src/lib/          coordinate math, distance/bearing, import/export, Supabase client
src/store/        Zustand stores: auth, waypoints (offline queue), teams, tracker
src/components/   shared UI, header, tab bar, auth screen
src/tabs/         Convert, Track, Waypoints, Team, Data
supabase/migrations/  schema, RLS policies, storage rules
brand/            icon-master.png — the emblem, source of every app icon
scripts/          make-icons.mjs — regenerates the PWA icons from the master
```

### Things to know before changing code

- **Coordinate parsing is deliberately strict.** `src/lib/coords.ts` rejects
  ambiguous input rather than guessing — a wrong coordinate that looks
  plausible is the worst possible failure for a rescue crew. Do not "fix"
  a rejection by making the parser lenient without a test proving the input
  is unambiguous.
- **Supabase keys are compiled in on purpose.** `src/lib/supabase.ts` falls
  back to the project URL and publishable key. Both are publishable; RLS is
  the security boundary. Never add a service-role key to this repo.
- **RLS is the security model.** Any schema change needs matching policies in
  a migration under `supabase/migrations/`, applied to project
  `puzwcsrtqtbutypzozvu`. `anon` must have no policy on any table.
- **Waypoint writes go through an offline queue** (`src/store/useWaypoints.ts`).
  A failed op stays queued and stops the queue — order matters between ops on
  the same row.
- **Icons are generated from one master.** `brand/icon-master.png` is the
  RescueGPS emblem, cropped square on the brand navy; `scripts/make-icons.mjs`
  derives `icon-192`, `icon-512` and `icon-maskable-512` from it on every
  build. Replace the master to change the artwork — never hand-edit the PNGs
  under `public/`, they are build output. The master lives outside `public/`
  on purpose: anything in there is published and precached.

## Session log

<!-- newest first; append a new dated entry on every "end session" -->

### 2026-08-05 — claude/daylight-tides-home-page-jlrznj

Opened with a screenshot of another app's GPS page and "add the daylight
tracker function and the tides near me function to the home page". There was no
home page — the app opened on Convert — so one was built, and the session then
grew by request into compass, waypoints, ETA, navigation and three bugs.

**New pages.** The app opens on **Home** (position in DDM/DMS/DD, daylight
countdown, nearest waypoints). **Tides**, **Compass** and **ETA to waypoint**
each became their own section on request, and each takes its own position fix
because any of them can be reached from the menu without passing through Home.

**Daylight tracker** (`src/lib/sun.ts`) — countdown to the next dawn, sunrise,
sunset or dusk, plus all four times and the length of the day. Computed on the
device on purpose: a crew out of coverage is exactly the crew that needs to
know how much light is left. Dawn and dusk are civil twilight, which is what
bounds a daylight search. Polar day and night return null rather than
inventing a time. Checked against published times for Houston on 2026-08-06 —
06:17 / 06:43 / 20:12 / 20:38 — which is what the app renders, matching the
screenshot the session opened with.

**Tides near me** (`src/lib/tides.ts`, `src/store/useTides.ts`) — high and low
water from the nearest NOAA CO-OPS station, with the distance and bearing to
that station shown rather than hidden, so a gauge 200 NM away is visibly not
"the tide here". Requested in GMT and converted for display; asking for
station-local time would be hours wrong whenever the phone is in a different
zone. Station list cached 30 days so nearest-station lookups survive losing
signal. **Never exercised live** — the sandbox proxy 403s
`api.tidesandcurrents.noaa.gov`. On the fix list.

**Compass** (`src/store/useHeading.ts`) — rose turning under a fixed lubber
line, magnetometer first with GPS course as fallback, naming which it is using
because one works standing still and the other does not. Headings smoothed as
a unit vector so the needle does not swing to south crossing north.

**ETA and 60 D Street** (`src/lib/sixtydst.ts`) — `60 × D = S × T`, NM, knots,
minutes. Fill any two, get the third, with the sum printed rather than only
the answer. Zero is treated as missing, not as a value: a speed of zero never
arrives. No unit argument anywhere — knots are NM per hour, so a statute mile
in D is a wrong answer that looks right.

**Stamping and photos.** "Stamp my position" is fixed in the footer on every
screen and opens a sheet for name, notes and a photograph. The fix is written
before anything is typed, so walking away mid-sentence costs a caption, not a
location. Photos can now be attached to a waypoint that already exists, from
the sheet or from Edit.

**Navigation.** Eight sections would not fit a phone as a tab row, so it became
one control naming the current section that opens a list of all of them. The
sheet behind it and the stamp form are one component
(`src/components/Sheet.tsx`) owning the portal, Escape and scroll lock. Both
are portalled because the footer's backdrop blur becomes the containing block
for anything fixed inside it.

**Three bugs, all found by driving the built app in a browser rather than by
reading it**
- **Track tab painted nothing.** `useWaypoints.visible()` built a new array on
  every call and was read as a Zustand selector, so React saw the store change
  on every render and looped forever. The merge is memoised on its inputs, with
  a regression test.
- **Waypoints could not be created offline.** `create()` identified the user
  with `supabase.auth.getUser()`, which asks the server; with no signal it
  returned nothing and gave up *before* reaching the offline queue that exists
  for exactly that case. Now reads the stored session, as `load()` already did.
  Caught because the stamp button silently did nothing in a sandbox with no
  network.
- **Creating a team died on a self-healing error.** PostgREST's `PGRST002`
  ("Could not query the database for the schema cache. Retrying.") was shown
  verbatim and treated as final. The database was checked first rather than
  guessed at: `create_team` ran correctly as the signed-in user inside a
  transaction that rolled back clean, so nothing was wrong with the schema.
  `src/lib/retry.ts` now retries the transient classes — PGRST000/001/002 and
  502/503/504 — four times over about seven seconds, and deliberately does not
  retry an RLS refusal (a decision), a statement timeout (already too slow) or
  a lost connection (the queue handles that, and seven seconds of retrying only
  delays the truth). The Team page also stopped asserting "You are not on a
  team yet" when the load had failed — it could not tell that apart from an
  empty list and stated the more alarming of the two as fact.

**Track recording** gained a user-set interval (10/15/20/30 s) and the path is
drawn north-up, scaled to fit, waypoints marked, with a scale bar. It is a
plot, not a map — tiles need a connection at the moment you may not have one.

Tests 174, up from 65. Typecheck, lint and build clean throughout.

**Verification note.** Everything above was exercised in headless Chromium
against the production build with a seeded session: all sections paint, the
stamp button holds position through a scroll on every one of them, the menu
closes on Escape and on a backdrop tap, the tracker recorded real breadcrumbs
from simulated movement, and the retry was driven with a stubbed API returning
the real PGRST002 body. Supabase and NOAA remain blocked from this sandbox, so
signed-in sync and live tide data are still unverified end to end.

**Supabase.** Project `puzwcsrtqtbutypzozvu` is now named `RescueGPS NavMate`
(that fix-list item is done). It pauses when idle, which is what produced the
PGRST002 — worth a plan that stays warm before anyone relies on this
operationally. A second project named `rescuegps-production`
(`ekhvfypxuxskjglwwoqh`) exists in the org and is *not* the one the app uses;
the name will mislead someone later.

### 2026-08-05 — claude/html-refactor-features-c0oebh

Session opened with "the HTML files don't need to stay HTML — make everything
functional and list the features". There was nothing left to convert: the
prototype was already rebuilt as React/TS in the previous session and the only
`.html` in the repo is `index.html`, Vite's mount point. So the session became
an audit of the app for things declared but not wired up, plus the feature
list.

**Functional gaps closed**
- **Waypoint editing.** The app could create and delete waypoints but never
  correct one. Each card now has an inline edit form for name, coordinates and
  note (`src/tabs/WaypointsTab.tsx`, extracted into a `WaypointCard`
  component). It sends only the fields that actually changed, so two people
  editing different fields of the same shared waypoint do not overwrite each
  other.
- **Edit/Delete now match the RLS policy** — own waypoints, or anything in a
  team you administer. Previously Delete was offered to every member. A write
  the database refuses stays at the head of the offline queue and blocks every
  write behind it, so offering an impossible control was a real hazard, not a
  cosmetic one. Wired `useTeams.myRole` in, which had been dead since it was
  written.
- **Track recording surfaced.** `useTracker` had been accumulating a
  2000-point trail that nothing ever read. The Track tab now shows point
  count, distance travelled and elapsed time, with GPX `<trk>` export and a
  clear button (`trackToGPX` in `src/lib/transfer.ts`, `clearTrail` in the
  store). `trailDistanceNM` in `src/lib/geo.ts` skips legs shorter than the
  worse of the two fixes' accuracy, so a phone on a dashboard does not
  accumulate miles of GPS jitter as distance travelled.
- **CSV import.** CSV was an export format that could not be read back. Added
  an RFC 4180 reader (`parseCsvRows` / `parseCSV`) handling quoted commas and
  newlines, doubled quotes, BOM and CRLF, matching columns by header alias so
  files from other tools work. `parseImport` routes to it on a `.csv` filename
  or a header naming latitude and longitude — deliberately not on "anything
  that isn't JSON", so genuinely unreadable input still fails loudly.
- **Export scope.** The Data tab said "N waypoints" while exporting private
  and team waypoints together, whatever scope the Waypoints tab was showing.
  Export now follows the active scope, with an explicit Everything toggle.

**Two bugs found while auditing**
- A signed-out account's cache and offline queue stayed in `localStorage`. The
  next person to sign in on that device saw the previous user's waypoints
  until the first sync returned — indefinitely if offline — and queued deletes
  would have been replayed under the new session. `useWaypoints` now records
  an `ownerId` alongside the cache and drops it when a different account signs
  in. The check uses `auth.getSession()` (local) rather than `getUser()`
  (network) so it still works with no signal, which is exactly when it
  matters. Clearing on sign-out was considered and rejected: it would destroy
  a user's own unsynced queue every time they signed out.
- Import coerced a missing coordinate to zero. `Number('')`, `Number(null)`
  and `Number([])` are all `0`, so absent data became a plausible-looking
  position in the Gulf of Guinea — precisely the failure mode `coords.ts` is
  strict about. A test written for the CSV reader caught it. A shared
  `toNumber` helper now rejects those, applied to all three import paths
  (JSON, GPX, CSV).

Tests: 65, up from 46. Typecheck, lint and build clean.

**Deployment progress** (the second half of the session)
- The Vercel project **now exists** — `rescuegps-navmate`
  (`prj_QkHXnAngwdCSZwz1S0qAVeDNPvJT`), created by the user from the GitHub
  import. The previous session's 403 was a token permission limit, not a
  configuration problem, and it still applies: this session could read Vercel
  but not create.
- Root cause of the wrong deploy branch found: the **GitHub repo's
  `default_branch` is still `claude/rescuegps-subdomain-setup-gchtnn`**, so
  the Vercel import inherited it as the production branch. The user has since
  set Vercel's production branch to `main` (Settings → **Environments** →
  Production — Vercel moved it out of Settings → Git, which is where
  DEPLOYMENT.md said to look). The GitHub default branch is still unchanged
  and should be pointed at `main` too, or the next import repeats this.
- Only one deployment existed before this merge: `90498e6` from the old
  session branch. Content-matched `main`, but predated everything above.
- Note for future sessions: the project's `-git-<branch>-` alias domain is
  attached to the *deployment*, not the branch setting, so it is **not** a way
  to verify which branch production tracks. The Environments page is.

**Correction to the previous session log**
- It recorded every commit as unsigned and showing Unverified on GitHub.
  Vercel's deployment metadata for `90498e6` reports
  `githubCommitVerification: "verified"`. Not confirmed directly in the GitHub
  UI, so the `fix_list.md` item stays open — but the claim that they are all
  Unverified looks wrong, and it should be checked before anyone spends effort
  retrofitting signatures.

### 2026-08-03 — claude/rescuegps-subdomain-setup-gchtnn

Initial build. Repo was empty at session start.

**App rebuilt from the prototype**
- Replaced the single-file vanilla JS prototype with Vite 7 + React 19 +
  TypeScript, Tailwind v4 and Zustand. Installable PWA; app shell and cached
  waypoints work offline, and writes made offline queue and flush on reconnect.
- Coordinate parsing hardened (`src/lib/coords.ts`): rejects a hemisphere from
  the wrong axis, a minus contradicting the hemisphere, minutes/seconds at 60+,
  and a fractional degree followed by minutes.
- DMS/DDM formatting rounds once on the total so `59'59.99"` carries into the
  next minute instead of rendering `59' 60.0"`.
- UTM honours the zone 32V and Svalbard exceptions and returns empty outside
  the 80°S–84°N domain.
- ETA gained compass points, NM/mi/km units and an arrival clock time.
- 46 unit tests across `coords`, `geo` and `transfer`.

**Backend** (Supabase `puzwcsrtqtbutypzozvu`, reusing the former
`plan-review-repeat` project rather than paying for a new one)
- `profiles` / `teams` / `team_members` / `waypoints`. Waypoints are private
  unless given a `team_id`.
- Teams created/joined via SECURITY DEFINER RPCs so the team and its first
  owner row are written atomically. Join codes omit I, L, O, 0, 1.
- Photos moved from base64 data URLs in jsonb to a private Storage bucket with
  signed URLs.
- RLS on every table, no `anon` policy anywhere. 31 access checks run against
  the live database with three throwaway accounts; all test data removed.
- Three bugs found and fixed by that pass: `anon` held EXECUTE on the team RPCs
  via the default PUBLIC grant; the last-owner guard blocked team and account
  deletion by firing on cascades; and the cascade fix then broke "leave team"
  for everyone until the trigger was made SECURITY DEFINER.

**Deployment**
- `vercel.json` pins framework, build, SPA rewrite and security headers.
- Supabase URL + publishable key compiled in, so no env vars are needed.
- `DEPLOYMENT.md` documents the Vercel import, subdomain attach, Supabase Auth
  URL config and project rename.
- **Not deployed.** The MCP deploy attempt returned
  `403 "You don't have permission to create a project."` — the connected Vercel
  token can read projects but not create them. No partial project was left
  behind. `stationinsight.com` lives on the `bunker-gear` Vercel project in the
  same team, so the subdomain should configure DNS automatically once added.

**Session protocol**
- Copied the start/end-session protocol and SessionStart hook from
  `jcochran6810/pressure-washing` (MyTradeCrate) and adapted it: added
  `npm run lint` to the baseline (this repo has a working ESLint config),
  and taught the hook to distinguish "origin/main does not exist" from a
  network failure.
- Fixed an inconsistency carried over from the source repo: a dirty tree
  printed a `⛔ … STOP` sync message but did not set the `SESSION-START
  BLOCKER` header that CLAUDE.md's turn-1 rule keys off, so the assistant
  would have read "stop" and continued anyway. Dirty now blocks on
  `source=startup` or when also behind main, and warns otherwise.
- Bootstrapped `main` from this branch — the repo had no `main`, which would
  have made the protocol emit a blocker on every session.
- Exercised all eight hook paths against a scratch clone: on-main, detached
  HEAD, missing origin/main, dirty×{startup, resume, behind}, behind
  (fast-forward), ahead×{resume, startup}. Confirmed resume preserves ahead
  commits and startup discards them.

**Commit signatures**
- Every commit in this repo is currently **unsigned** — GitHub will show them
  all as Unverified. Author/committer is correctly `Claude
  <noreply@anthropic.com>`; what's missing is a signature. `commit.gpgsign` is
  true locally but no usable signing key exists in the build sandbox
  (`gpg.ssh.allowedSignersFile` is unset, so git cannot even verify locally).
- A stop-hook flagged the merge commit and suggested
  `git commit --amend --reset-author`. That was **not** done: the commit was an
  already-pushed merge on `origin/main`, so amending it would have required a
  force-push to main, which this protocol forbids — and it would have fixed
  only one of six equally unsigned commits. The branch was pushed to match main
  instead; no history was rewritten.
- If verified badges are wanted, a signing key has to be configured in the
  environment that makes the commits. Retrofitting means rewriting the whole
  history, so it gets more expensive the longer it waits.

**Known gaps**
- The signed-in flow has never run in a real browser; this sandbox blocks
  outbound traffic to `*.supabase.co`. Verified at the database and unit-test
  level only.
- No map. Deliberately out of scope for this pass.
