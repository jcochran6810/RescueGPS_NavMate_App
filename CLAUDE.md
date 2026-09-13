# CLAUDE.md

Project-specific instructions for Claude Code when working on this repository.

RescueGPS NavMate is a static single-page app (Vite + React 19 + TypeScript)
backed by Supabase, served at `rescuegps.stationinsight.com`. It shares a
parent domain with Station Insight and nothing else — separate repo, separate
hosting project, separate database.

**NavMate is the field app, RescueGPS is the system it reports into.** NavMate's
job is collecting data where the work happens — position, waypoints, notes,
photographs — holding it when there is no signal, and sending it on. That is why
capture is always allowed to succeed offline and sync is always the thing that
waits, not the other way round. Keep that ordering when adding anything that
writes.

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
brand/            emblem.png / logo.png — the artwork every icon derives from
scripts/          make-icons.mjs — regenerates the icons from the masters
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
- **Icons are generated from two masters.** `brand/emblem.png` is the
  RescueGPS cross, `brand/logo.png` the whole logo with the wordmark. Both have
  their navy field knocked out to transparency, so the artwork takes the colour
  of whatever is behind it instead of carrying a rectangle of its own.
  `scripts/make-icons.mjs` derives everything under `public/` from them on
  every build: the launcher icons opaque on the app background (`#06131f`, the
  `body` colour in `src/index.css`), and `emblem-192`/`logo` transparent for
  in-app use. Replace a master to change the artwork — never hand-edit the PNGs
  under `public/`, they are build output. The masters live outside `public/` on
  purpose: anything in there is published and precached. If the app background
  ever changes, `APP_BG` in the script has to change with it.

## Session log

### 2026-09-13 — claude/charming-rubin-rlz3ks (chart plotter)

"How can I add an automatic chart plotting feature… free API access… charts
with depths… plots a course and provides distance, time until destination."
Decisions taken with the user first: US waters only, team-shared vessel list,
route at chart datum, build the whole feature.

**A correction to the premise, surfaced before building.** The request said
"boat draft, top speed and other information is already set". It was not —
there was no vessel profile anywhere: `profiles` is `id/email/full_name/
callsign` and had never been extended, the only persisted preferences in the
app were the tracker's `intervalS`/`gateM`, and every speed on every screen
was a transient `useState` (`SearchTab` defaulted to a hardcoded `'6'`). So
the vessel profile is part of this work, not a prerequisite.

**And a blocker found on the way, now at the top of `fix_list.md`:** the
Supabase project the app compiles in (`puzwcsrtqtbutypzozvu`) **is no longer
NavMate's database.** It is now named "Where's my note" and holds `notes`,
`comments`, `calendar_events`, `attachments`. None of NavMate's tables exist
there; `rescuegps-production` carries the *command* schema, not this one. Found
because the vessels migration failed with `relation "public.teams" does not
exist`. The migration is written and committed but **unapplied**, and the live
app's sync is pointing at a database that cannot serve it. Everything in this
session works offline against local caches regardless, which is the only reason
the feature is still usable.

**The route planner** (`src/lib/routing.ts`, 36 tests). Rasterise the charted
depth areas, land and point hazards into a grid keeping the shoalest depth per
cell; mark a cell usable when that depth clears draft + under-keel margin *at
chart datum*; grow the blocked cells by the crew's stand-off with a 3-4 chamfer
distance transform (which doubles as the mid-channel preference); A* with an
octile heuristic and no corner-cutting; then a supercover line-of-sight
string-pull that turns a 400-step staircase into the three or four legs a
coxswain actually steers. Two refusals are deliberate and documented in the
file header: **unsurveyed water is not usable** (not shallow, but not known to
be deep — the same refusal `coords.ts` makes about an ambiguous coordinate),
and **no tide is ever added to a charted depth** (tide is shown beside the
route; `tidalOpportunity()` surfaces the shortcut as a decision rather than
taking it). Every failure mode returns a straight line with a warning rather
than a blank screen. Runs inline, not in a worker: 114 000 cells end-to-end in
~60 ms.

**The chart data** (`src/lib/chart.ts`, 40 tests). NOAA Chart Display Service
for the raster — a WMS, so tiles are `GetMap` over each tile's EPSG:3857 bbox
in **metres** (`tileBbox3857`, asserted against independently computed Mercator
values; the retired `tileservice.charts.noaa.gov` XYZ service is deliberately
not used). ENC Direct to GIS for the depths and hazards, by usage band chosen
from the passage length. **Layer ids are discovered at runtime and matched by
name, never hardcoded** — NOAA republishes weekly and renumbers, and a
hardcoded id coming back as something else routes a boat through a shoal.
`exceededTransferLimit` splits the box into quadrants and retries; still
overflowing reports the area `partial`, which becomes a warning on the route
rather than being swallowed. Geometry parsing accepts GeoJSON *and* Esri JSON,
because `f=geojson` is not guaranteed on every ArcGIS version and none of this
can be checked from a sandbox the proxy blocks.

**The boat** (`src/lib/vessel.ts` + `supabase/migrations/…_navmate_vessels.sql`
+ `src/store/useVessels.ts`, 18 tests). Team-shared, because a department's
Marine 2 has one draft and a member retyping it from memory is how a boat ends
up on a bar. Metric in the record, feet in the form — charted depths are metres
and a draft kept in two units is a draft that disagrees with itself. Store
copied from `useIncidents` with all three queue safeguards intact.

**The screen** (`src/tabs/ChartTab.tsx`). Boat → chart → destination → course →
steering. Tap-to-pick needed an `unproject` on the map, which already existed
inline inside `zoomAround` and is now factored out and used by both; tap-vs-drag
has to be discriminated by hand because the container takes pointer capture and
is `touch-none`, so no click event ever arrives. `SatelliteMap` gained a `base`
prop (chart/satellite), a seamarks overlay, a **per-source zoom clamp** (it had
been clamping everything to `SATELLITE`'s range, which would have requested
levels the chart does not publish), and `saveArea` now pulls whatever layers are
actually on screen. Destinations come from a tap, a saved waypoint, typed
coordinates (through the strict parser), or **the active incident's LKP** —
getting to the datum is the first move of every search this app exists for, and
until now it was a straight line.

**A real refactor rather than a copy:** `SteerCard` moved out of `SearchTab`
into `src/components/SteerCard.tsx` with its rule in `src/lib/steer.ts`, and
`buildLegs` is now exported from `search.ts`. A route leg and a pattern leg are
the same object, so there is one definition of what to steer and no way for the
two screens to drift apart.

**Verification.** 391 tests, up from 284. The routing tests assert against
hand-drawn ASCII charts with the answer read off the page — a hole in a
polygon left unfilled, a wall with one gap, a corner two rocks touch at that a
boat cannot use and neither may the route, a dead end, a bar that a 1.5 m boat
must go round and a 0.8 m boat may cross. Plus a 31-check headless-Chromium
drive of the production build against a stubbed NOAA (`scripts/drive-chart.mjs`,
committed this time rather than discarded): tap-to-pick unprojects to the right
place, the course goes **round** the stubbed bar (2.94 NM against 2.40 NM
direct) with no leg shallower than the boat needs, legs/ETA/arrival/least-depth
all render, steering advances, turn points save as waypoints, and a dead ENC
service degrades to a warned straight line. No sideways scroll at 320/360/390.

**Not verified, and in `fix_list.md`:** every NOAA endpoint here (the proxy
403s all three hosts, exactly as it does for tides and imagery) — specifically
the WMS `layers=` list, the ENC layer names per band, and whether any host
sends `Access-Control-Allow-Origin`, which the **queries** genuinely need even
though the tiles do not. Also: the service-worker offline path (Playwright
cannot stub SW fetches), plot timing on a real phone, and that bridges are read
for air draft but do not yet block a route.

### 2026-08-31 — claude/reset-cochranlawncare-password-8kty0x (account admin)

"Reset my password for user cochranlawncare@gmail.com to station10." All
work was on the live Supabase project (`puzwcsrtqtbutypzozvu`) — **no code
changed**; this entry is the only commit.

- The account did not exist — the project held only
  `jason.cochran@universalhazard.com` (platform admin, owner of Baytown FD
  Marine 2) and `tonyhenry2012@gmail.com` (member). Surfaced that instead
  of guessing; the user chose **create it**.
- Created `cochranlawncare@gmail.com` via SQL: `auth.users` row with
  bcrypt password, email pre-confirmed, matching `auth.identities` row
  (provider `email`, `sub` = user id — GoTrue misbehaves without it), the
  string-typed token columns set to `''` not NULL (GoTrue scan errors on
  NULL). The `profiles` row arrived by trigger. Verified in-database:
  hash matches the password, identity and profile exist. Account has no
  team, empty profile, no admin rights.
- On request, also reset `jason.cochran@universalhazard.com` to the same
  password (UPDATE of `encrypted_password`, verified against the stored
  hash). Existing signed-in sessions were left valid — a password change
  does not revoke refresh tokens, and the user was told so.
- Both accounts now share one password; worth changing to distinct ones
  before anyone else touches these accounts.

### 2026-08-06 — claude/navmate-search-aids-tools-hq8ezo (search aids & tools)

"Work on the search aids and tools; consult rescuegps-navigator-pro and
apply its ontology and rules; nothing that needs heavy backend computing;
simplify so a search runs from a phone; team members on the same incident,
picked up by rescuegps-navigator-pro when an IC gets on location."

**The command repo was read first, thoroughly** — two research passes over
`rescuegps-navigator-pro`: one over its data ontology (`incidents` schema,
the `client_id` offline-sync contract, `field_drift_data`,
`incident_participants`, the field-activation payload), one over its search
doctrine (`manu/core/doctrine/ontology.json` v0.2.0, IAMSAR Vol II Ch 5 as
amended by MSC.1/Circ.1594: pattern laws, sweep-width/POD tables, the
88-entry Allen & Plourde leeway table, the survivability model). Everything
below speaks that system's language; everything heavy — Monte Carlo drift,
effort allocation, probability maps — deliberately stayed on the command
side.

**Incidents** (`supabase/migrations/20260806150000_navmate_incidents.sql`,
`src/store/useIncidents.ts`, `src/lib/incident.ts`,
`src/components/IncidentCard.tsx` — migration applied live). The container
a search runs in: everyone on the team sees the same incident, and
everything logged while it is open is tagged to it, so two phones on one
boat — or two boats on one team — are working the same search. Column
names, the 22 incident-type codes and the 9 status values mirror the
command side's `incidents` table **exactly** (`lkp_lng`, never lon), so
adoption is an INSERT, not a translation. Three deliberate divergences,
each fixing a flaw documented in their own code: `client_id` idempotency
(their incidents have none and their offline fallback ids never sync), a
real `incident_time` column (they overload `lkp_time`, silently zeroing
drift time), and no plaintext password column (team membership is the
scope). Opening an incident adopts the last 24 h of untagged records in
scope — LKP-first-incident-second is the real field order. **Handoff to
command** exports the incident + `lkp_history` + `field_drift_data` (the
measured drift card is their cleanest seeding channel) + clues as
`field_events` + `simulate_drift_params`, all in their field names.
Incident numbers are their field format with the random tail widened
(`INC-YYMMDD-` + 5 base-32 chars) because their 4 digits can collide
against a UNIQUE column.

**Search patterns** (`src/lib/search.ts`, `src/tabs/SearchTab.tsx` — new
"Search pattern" section). Expanding square (leg law ceil(i/2)×S, 90°
starboard, CSP is always the datum), sector search (the 9-leg three-
triangle clover, 120° turns, first leg down-drift), parallel track, and a
**true creeping line** — legs across the drift axis advancing S along it;
the command side's own generator relabels a parallel sweep there and
records it as a known simplification, which was not copied. The tab
suggests a pattern from the ontology's selection rules (datum radius +
drift), sizes track spacing from the visual sweep-width table (object
visibility × day/night × sea state — day/night defaults from the sun
math), shows C = W/S and POD = 1 − e^(−C) honestly, estimates time with
the 2-min turnaround allowance, draws the plan dashed on the satellite map
next to the actual track ("the gap between them is what is left to
search"), saves turn points as waypoints, and **steers the pattern leg by
leg** — live course/distance to the next turn point, auto-advancing inside
0.05 NM, with tracking held on so the track records coverage.

**Survival clock** (`src/lib/survival.ts`, card on the pattern page). The
water-temp field promised it since the datum session; now it exists: USCG
baseline windows + PFD multipliers + immersion phases from the command
side's survivability model, cut to the three inputs a coxswain has (water
temp, time in, PFD status). The governing rule carried over verbatim:
drowning kills faster than hypothermia, and past-the-estimate reads as
urgency, not a verdict.

**Leeway upgraded to Allen & Plourde form** (`src/lib/sar.ts`). The 15
field choices stay 15, but each now carries its canonical `leeway_type`
code and the real coefficients — downwind slope × wind + offset, plus a
crosswind component that is what actually puts the left/right datums off
the downwind line. Old saved keys resolve through an alias map; exports
emit only canonical codes, so the drift engine never sees a key it would
throw on.

**A real bug found in all three queue stores, fixed with a regression
test:** an op the server *accepted* left the queue without landing in the
cache, so a successfully synced waypoint/record/incident vanished from the
screen until the next load(). Every previous drive ran with Supabase
blocked — ops stayed queued, so it never showed. This session's drive stub
accepts writes and serves them back, which is what exposed it. The fix
folds completed ops into the cache in the flush finally block.

**Verification.** 284 tests (up from 251) — pattern geometry asserted
against hand-computed spiral corners and leg laws, POD against the
doctrine cheat sheet, the handoff against the command side's exact column
names. Plus a 25-check headless-Chromium drive of the production build
(stubbed PostgREST that persists writes, mocked GPS at the datum): LKP →
conditions → open incident (adopts both records, patches `lkp_lng`) →
plan, switch patterns, dashed route and turn squares on the map → save
waypoints → steer live → survival clock incl. PFD change → close with
outcome. No sideways scroll at 320 px; the menu with its new row is
726 px in an 844 px viewport. Migration advisors clean. Still unverified,
as ever: live Supabase RLS with real accounts (sandbox blocks it) — noted
in fix_list.md, along with the fact that the command tie-in is export-only
until the databases merge.

### 2026-08-06 — claude/project-ui-ux-plugins-ckldxe (UI/UX pass)

"Use the following plug-ins to improve this project and the ui/ux: taste,
impecable, playwright cli, awesome-design, img2threejs."

**Four of the five do not exist anywhere this account can reach** — not in
the plugin catalog, not in the MCP connector registry, not in the skill
library, searched by name and by intent. Only `playwright` was available,
already installed in the environment. The catalog's whole UI-relevant
inventory is two plugins, neither enabled: **Design** (`/design:critique`,
`/design:accessibility`) and **Modern Web Guidance**; install cards were
rendered for both. `Three.js 3D Viewer` is connected but was deliberately
not used — a WebGL scene in an offline-first field app is bundle weight and
battery for no navigational gain.

So the work was done with the one tool that was real: **every finding below
came from driving the production build in headless Chromium at 320/360/390
px**, not from reading the source. Verified the same way — 32 UI checks plus
a WCAG audit, on top of the unit tests.

**The section menu was the worst of it.** Twelve sections as one flat list of
two-line cards ran **1490 px inside an 844 px viewport**, so half the app was
reachable only by scrolling a menu and Help/Contact and Platform admin were
below the fold every time. Grouped by the job being done now — Position /
Search / Records / Support — on single-line rows with the hint sharing the
row rather than taking one of its own. Fits without scrolling: 678 px for a
crew account, 726 px for an admin's twelve, at all three widths. The ▲ and ✕
buttons did the same thing, so one is gone; focus moves into the panel on
open and returns to the trigger on close, including on Escape, which had
been dropping it on `<body>`.

**The GPS badge said "off" above a live set of coordinates.** It only ever
tracked the continuous watch, so Home — which takes a single fix and prints
the position underneath — showed "GPS off" next to it. Three states now:
live / fix / off. A badge that contradicts the screen teaches a crew to stop
reading it.

**The team switcher is only rendered once there is something to switch
between.** On a solo account it was a full-width control with one option,
costing a header row on every screen to say nothing. The Waypoints tab
stopped pointing at it when it isn't there.

**Waypoint cards.** Copy/Edit/Delete were a narrow right-hand column, which
stacked the buttons vertically, made every card twice as tall as its
content, squeezed the name into half the width, and put Delete directly
beneath Edit — where a thumb aiming for one lands on the other. A row under
the detail now, Delete at the far end: **290 px → 162 px per card, 167 px
between Edit and Delete**. Each card also carries range and bearing from the
current fix, which is the field question and was only answered on Home's
nearest-four list.

**A bearing to a point you are standing on is noise.** Both lists printed
"0° N" for a waypoint 0.00 NM away — a heading a crew could act on, produced
by a metre of GPS jitter. `isAtPosition` in `geo.ts` is the single
definition of underfoot (0.01 NM, about 18 m), used by both so they cannot
disagree.

**WCAG AA.** An audit measuring every rendered text node against its
*composited* backdrop found 50 failures, all one cause: `text-slate-500`
carries every hint, caption, footnote and unit label in the app — 76
usages — and lands at 3.3–3.9:1 where AA wants 4.5:1 under 24 px. The whole
secondary scale moved up one step rather than flattening the lighter end
into the darker: slate-500 → slate-400 (7.3:1), and the labels that were
slate-400 → slate-300 (12.6:1). Placeholders moved too, because in this app
they *are* the visible label. 0 failures afterwards; tap targets and
accessible names were already clean (0 under 24 px, 0 unnamed).

**Trap for whoever measures contrast next:** Tailwind v4 emits `oklch()`, so
`getComputedStyle` returns colours a digit-grabbing regex reads as nonsense.
The first pass "found" 227 failures including white-on-navy at 2.3:1, which
is how the bug was caught. Painting each colour to a canvas and reading the
sRGB bytes back is what makes the numbers real.

Smaller: daylight times no longer wrap `11:19 AM` across three lines
(`sunClockParts` splits the digits from the suffix through `Intl`, so a
24-hour locale gets no suffix rather than a hardcoded split); the 60 D = S ×
T card printed its instruction twice one line apart; Home was the only
section with no heading at all, so a screen reader moving by headings fell
straight into the position card — it gets an `sr-only` h2 rather than a drawn
one, because a title bar would push the position further down the screen the
app opens on.

**Merge note.** `main` moved three commits ahead mid-session with the
satellite-map work. `TrackTab.tsx` conflicted structurally — main moved the
path plot into a Map card and added Fix quality — so main's file was taken
whole and the contrast sweep re-applied to it, along with the new
`SatelliteMap.tsx`, which had never seen it. `geo.test.ts` was purely
additive on both sides. 251 tests, typecheck, lint, build clean; both drives
re-run green after the merge.

### 2026-08-06 — claude/live-tracking-satellite-map-v09ado

"The live tracking needs to be more accurate. It also needs to show on a
satellite map." Two jobs, and the first one is the one that mattered: the
tracker was plotting whatever the receiver handed it.

**Accuracy** (`src/lib/track.ts`, `src/store/useTracker.ts`). Three stages
now sit between the GPS and everything that reads a position — the readout,
the track, the compass fallback, any datum taken from a fix.

- **Gate.** A fix reporting worse accuracy than the crew asked for (default
  ±25 m) is refused, so is one implying a speed nothing on the incident could
  make (130 m/s ≈ 253 kn, above a SAR helicopter), and so is one older than
  the fix before it. Refusals are **counted and explained on screen** — a
  silent gate is indistinguishable from a broken receiver. The limit is
  settable to ±10/25/50 m or off, because a crew under canopy or below deck
  needs to loosen it rather than be left with no position at all.
- **Filter.** A constant-velocity Kalman filter per axis, weighted by the
  accuracy the receiver itself reports, so a ±4 m fix moves the estimate and a
  ±40 m fix barely nudges it. A 4σ innovation gate drops the fix that jumped
  off a wheelhouse roof; three refusals in a row restart the filter there,
  because at that point the receiver has re-acquired somewhere else and is
  right. Process noise was **swept, not guessed** — 0.3 m/s² against simulated
  1 Hz fixes more than halves the scatter of a phone standing still while
  staying within a few metres of a crew turning at five knots.
- **Derive.** Velocity comes out of the filter, so speed and course exist on
  the many devices that report `null` for both — which also gives the Compass
  page a real GPS-course fallback for free. Speed reads zero rather than a
  wandering fraction of a knot when the velocity is smaller than its own
  uncertainty (the filter's covariance decides, not a fixed threshold), so a
  moored boat stops showing three knots of tide.
- Reported accuracy is the filter's own estimate, **floored at half what the
  receiver claimed**. A white-noise filter will happily claim centimetres;
  real GNSS error is correlated over minutes, so averaging does not beat it
  down anything like that fast, and the datum worksheet takes this number as
  an input.
- `watchPosition` now asks for `maximumAge: 0` — the default let the browser
  return a cached position, which makes a track of straight lines between
  whenever the cache happened to refresh — and allows 30 s, because under
  canopy a real fix genuinely takes that long and a timeout there reads as a
  fault when it is only patience.
- The tracker holds a **screen wake lock** while running, re-taken on every
  return to the page (browsers drop it whenever the page hides and never give
  it back). A breadcrumb now needs both the interval *and* movement larger
  than the fix is uncertain. One-shot fixes (`once()`) reuse the filtered
  position when it is seconds old rather than asking for a fresh, colder one —
  stamping stays instant and gets better.

**Satellite map** (`src/lib/tiles.ts`, `src/components/SatelliteMap.tsx`).
Esri World Imagery, no key — this app has no server to hide a token behind,
and a key compiled into a static bundle is a key given away. Written without a
mapping library: the map needed here is pan, zoom, a track and some markers,
and a library would have brought a second projection, a second event model and
a second offline story into an app with opinions about all three.

- Pan, pinch, wheel and buttons; follows the crew until they pan and comes
  back on Centre; Fit track for the whole path; an optional labels layer.
  View state is one object, so a gesture that moves and zooms at once cannot
  land half-applied and every gesture is a functional update — a fast drag
  never computes its next step from a centre React has not re-rendered yet.
- **The overlay is drawn from the fixes, not the tiles**: track, waypoints, an
  accuracy circle to scale, a true scale bar. That separation is the whole
  design — when imagery does not arrive the overlay is still exact, failed
  tiles are hidden rather than left as broken-image glyphs, and the map says
  the imagery is missing instead of showing a crew a blank sea. `Plot only`
  keeps the old north-up plot and fetches nothing at all. Before the first fix
  the map fetches nothing either, and says it has nowhere to be.
- Offline: tiles are cached by the service worker cache-first for 90 days (a
  photograph of the ground does not go stale on the timescale of an incident,
  and the crew who needs it most has no link left to revalidate it), and
  **Save imagery for offline** pulls the surrounding area at two zoom levels
  into that cache before the signal goes. That was the item that had kept a
  basemap out of this app since the first pass.

**Verification.** 244 tests, up from 193 — the filter is driven with seeded
Gaussian noise so a failure reproduces, and the tile maths is asserted against
Web Mercator values computed independently of the code. Plus a 34-check
headless-Chromium drive of the production build with stubbed tiles: the
requested tile is checked against those same values (Esri's path is
`{z}/{y}/{x}`, row before column, and getting it backwards returns real
imagery of the wrong place), a ±1500 m fix and a 5 km jump are both visibly
refused and then a genuinely moved receiver is believed, panning stops the
follow and Centre resumes it, `Plot only` fetches nothing, saving pulls tiles
down, and a dead imagery link degrades to a drawn track with a banner. No
horizontal scroll at 320 px. Typecheck, lint, build clean.

**Not verified:** the build sandbox's proxy 403s `server.arcgisonline.com`
exactly as it does NOAA, so no real tile has ever been fetched. What is
unconfirmed is whether Esri sends `Access-Control-Allow-Origin` for the
`crossOrigin="anonymous"` requests the map makes — the fallback (drop
`crossOrigin`, accept opaque cache entries) is written down in `fix_list.md`
along with the storage-budget question the new tile cache raises.

<!-- newest first; append a new dated entry on every "end session" -->

### 2026-08-06 — claude/rescue-gps-datum-app-074wfq (navigation rework)

Direct feedback on the admin dashboard and the app shell: fewer counters,
help as its own section, the menu in the top corner, account as a circle
button.

- **Menu moved from the bottom bar to the header's top-right corner** as a
  ☰ button dropping a panel down over the page (`NavMenu.tsx`, replacing
  `TabBar.tsx`). It carries both a ✕ close and a ▲ collapse control —
  visibly, not just Escape/backdrop, which still work. The footer now holds
  only the stamp button.
- **Account is a circle button** next to the menu (`AccountButton.tsx`),
  initials from callsign → name → email, opening a top-right panel with the
  profile fields (name/callsign, saved via the existing updateProfile) and
  sign out (keeping the unsynced-queue warning). The profile card left the
  Team page; the sign-out button left the header row.
- **Help / Contact is its own menu section** (`HelpTab.tsx`); the
  contact-admin card moved there from the Team page.
- **Admin metrics trimmed** to what runs the platform: users, active (7d),
  teams, open requests, app errors (24h), photo storage. New-this-week/month
  counters, waypoint/datum totals and the by-kind line are gone from the UI;
  `admin_metrics()` still returns them, so restoring any is a render change,
  not a migration.
- Verified in headless Chromium: 18-check drive of the new nav (corner
  position by bounding box, ✕ and ▲ both close, help section works, account
  panel edits save through the stub, admin reachable, trimmed metrics
  confirmed absent, stamp button still fixed) plus a no-horizontal-scroll
  check at 320/360/390 px with the offline badge forced on. 193 tests,
  typecheck, lint, build clean.

### 2026-08-06 — claude/rescue-gps-datum-app-074wfq (admin dashboard)

"Create an admin dashboard like MyTradeCrate's, jason.cochran@
universalhazard.com as platform admin, track metrics, take care of requests,
make user profile changes." The Pressure-washing repo was read first; its
pattern — `platform_admins` membership + SECURITY DEFINER `is_platform_admin()`
+ per-table "platform admin read" policies + an `admin_actions` audit row on
every mutation — ports to this serverless SPA verbatim, minus the Next.js API
routes: here every mutation is an audited SECURITY DEFINER RPC, because this
app has no server and never a service-role key.

**Schema** (two migrations, applied live): `platform_admins` (seeded by email
lookup, not a hardcoded uuid — the admin account already existed),
`support_requests` (kind/subject/body/status/admin_notes; users insert-only
and read their own; no user update — a filed request is part of the record),
`admin_actions` (append-only), `app_errors` (any signed-in client inserts,
admin reads), admin read policies on profiles/teams/team_members/waypoints/
sar_records, and RPCs `admin_metrics()`, `admin_list_users()`,
`admin_update_profile()`, `admin_update_request()` — each check
is_platform_admin() inside and write their own audit row. EXECUTE revoked
from public/anon everywhere.

**UI:** a Platform admin section, listed in the menu only for admins (the
database enforces regardless): metrics grid (users + new/active, teams,
waypoints + photos, datum records by kind, open requests, app errors 24h/7d,
photo storage), the request queue (Needs action / Resolved / Dismissed
filters, note back to the requester, Start/Reopen/Resolve/Dismiss), accounts
with inline profile edit (name + callsign via the audited RPC), and the
recent-actions log. Deliberately online-only — a dashboard is a desk tool;
it keeps the last numbers and says why when a load fails. Users file
requests from a "Contact the platform admin" card on the Team page and see
the admin's note come back under their request. MyTradeCrate has no requests
table at all — this queue is NavMate's own answer to "take care of
requests". Runtime errors report into `app_errors` via window handlers
(throttled, deduped, never queued offline, silent on failure).

**Verification:** 193 tests still green; 12-check headless-Chromium drive of
the production build with a stubbed Supabase: non-admin never sees the menu
entry and files/sees own requests; admin sees metrics, works the queue with a
note, edits a profile, and both mutations land in the audit log. One find on
the way: Playwright route stubs don't intercept service-worker fetches — the
drive blocks SWs; noted here because the next person to stub the backend in a
test will hit the same wall.

### 2026-08-05 — claude/rescue-gps-datum-app-074wfq

"Do a full code based analysis, fix bugs and dead ends, finish the planned
features, consult the other RescueGPS repo" — NavMate's job restated as a
**standalone datum-collecting app for a single unit searching for a victim**,
reporting into RescueGPS later with shared tables.

**The RescueGPS repos were read first** (`rescuegps-navigator-pro`,
`rescuegps-backend`). What that established: RescueGPS models a datum as
LKP + (current × time) + (leeway × time); its drift engine's `simulateDrift`
takes `lat/lng`, wind FROM in degrees, current TOWARD in degrees, knots, and a
`leeway_type` key; its field tables (`asset_tracks`, `field_events`) sync
offline via a UNIQUE `client_id` upsert; and **no table anywhere stores what a
field unit observes for the drift engine** — the biggest gap in the ecosystem,
and the thing this session built.

**New: the Search datum section** (`src/tabs/DatumTab.tsx`, `src/lib/sar.ts`,
`src/store/useSarRecords.ts`, `sar_records` table — migration applied to the
live project):
- LKP with the fields the drift engine actually needs and never had a home:
  position, **time last seen**, source (GPS/witness/estimated), position
  error, search-object type from the USCG/IAMSAR leeway table (keys match
  RescueGPS `leeway_type`).
- On-scene conditions in the engine's conventions — wind FROM, current
  TOWARD, both labelled, because a swapped convention is a datum on the wrong
  side of the LKP.
- Drift markers: deploy at position, retrieve at position, measured set and
  drift computed and offered back as the current. A real observation beats
  any forecast.
- Clue log with position and time.
- A live worksheet: datum = LKP carried by current + leeway for the time
  adrift, left/right divergence positions, search radius = 1.1 × RSS(LKP
  error, nav error, 0.3 × drift). Verified against hand-computed values in
  headless Chromium.
- Ties: datum saves as a waypoint (ETA/Compass/Track steer to it); report
  exports as JSON in RescueGPS field names (`lng`, `simulate_drift_params`)
  ready for the engine; everything rides an offline queue with the same
  guarantees as waypoints.

**Bugs fixed (two independent audits, one by an agent reading every file):**
- `flush()` replaced the queue wholesale from a snapshot — any op queued
  while a flush was in flight was destroyed. Stamp twice quickly on a slow
  link and the second waypoint vanished. Now reconciles appended ops.
- A permanently refused op (RLS, bad row) blocked the queue forever with no
  UI. Now set aside after 3 attempts, still **visible in the lists** (a
  refused LKP disappearing reads as data loss — found by driving the build,
  where the sandbox proxy 403s Supabase), with Retry/Discard in Data.
- A queue could be replayed under a different account's session. Now guarded.
- Convert tab: editing one coordinate wiped the other (shared `source`/`raw`
  state re-parsed both axes from stale text). Per-axis now.
- "Stamp another" discarded the name/note just typed — commits first now.
- Offline photos: the toast promised an upload that never happened. Staged
  photos now upload automatically on reconnect (memory-only; honest copy).
- Password reset was a dead end — `PASSWORD_RECOVERY` unhandled, no
  `updateUser(password)` anywhere. New RecoverPassword screen.
- iOS `webkitCompassHeading` is **magnetic** (Apple docs), was labelled true;
  the declination warning now shows on the platform that needed it.
- Tides/Compass stranded on "take a fix" with no error shown and no retry;
  `addPhotos` concurrent-write erased teammates' photos; waypoint edits
  re-rounded coordinates on every save; ETA/Compass pickers ignored team
  scope; import dropped DMS rows silently (now parsed, skipped counted);
  deleted waypoints leaked their photos in Storage; tide refresh dropped
  position changes mid-request; daylight countdown blanked after events;
  sign-out with a queued backlog warns; `icon-512` was precached despite the
  ignore; `registerSW.js` now no-cache in vercel.json.

Tests 193 (up from 174), plus a 22-check headless-Chromium drive of the
datum flow against the production build. Typecheck, lint, build clean.

**Supabase:** `sar_records` created on `puzwcsrtqtbutypzozvu` with
waypoints-style RLS (no anon policy); advisors show nothing new. The
migration comment documents the column mapping for the eventual merge with
RescueGPS's database (`ekhvfypxuxskjglwwoqh` carries none of these tables
yet — its backend has no database at all).

### 2026-08-05 — claude/daylight-tides-home-page-jlrznj (naming)

Short session. "Add NavMate after the RescueGPS", with the product context that
**NavMate is the field app that collects and sends data to RescueGPS, the main
software.**

**The header names both** — `RescueGPS` in white semibold, `NavMate` in the
brand blue at a lighter weight, so the pair reads as system and app rather than
as one long string.

**Fitting it needed measuring, not guessing.** That row also carries the
queued-writes and GPS badges, which take 143 px of a 320 px screen. The name
steps down 16 → 14 → 12 px as the screen narrows rather than truncating, and
below 360 px the emblem gives way instead of the name: at 320 px the name needed
128 px and had 113, and the 32 px the mark was holding closes it exactly. The
emblem is decorative there — no alt text — so a screen reader loses nothing.
Verified at 320, 360, 390 and 430 px with both badges forced on: full name at
every width, no truncation, no sideways scroll.

**The relationship is now recorded** at the top of this file and of README.md,
because it explains the app's shape: capture must succeed offline and sync is
the thing that waits, never the other way round. Worth stating for whoever adds
the next feature that writes.

Left alone deliberately: the sign-in screen shows the full logo, whose wordmark
already reads `RESCUE GPS`, with `NavMate` as the heading beneath it. Those
already read as "RescueGPS NavMate" together; spelling it out would repeat the
wordmark.

### 2026-08-05 — claude/daylight-tides-home-page-jlrznj (branding)

Same branch, later session. "Use this for the icon and for the pwa download",
with the RescueGPS artwork attached — the Maltese cross carrying a boat and a
position pin, over a `RESCUE GPS` wordmark.

**The artwork is now the app's identity** — favicon, Apple touch icon, PWA
install tiles, the sign-in screen (full logo, wordmark included) and the header
(emblem alone at 24 px, where the wordmark would be unreadable). The
placeholder compass mark and `public/icon.svg` are gone.

**Two masters, everything derived** (`brand/emblem.png`, `brand/logo.png`).
`scripts/make-icons.mjs` generates every file under `public/` from them on each
build, so there is one place to replace artwork and no way for the sizes to
drift. The masters sit outside `public/` deliberately — anything in there is
published and precached, and these are build inputs.

**The generator had to grow.** It used to walk a few circles and a triangle
with signed-distance tests, which is what the old mark was; a cross with waves
and a wordmark is not. It now decodes a PNG, box-filters it to size and
composites it onto a tile — a decoder, a resampler and Paeth filtering on the
way out, still with no image library, because this runs in the Vercel build and
a native dependency there is a whole class of deployment failure for what
amounts to a decode and an average. The box filter is not incidental: the
silver outline on the cross is about one pixel wide at 192, and point-sampling
drops stretches of it.

**Sizing is honest about the source.** The emblem is 474 px in the original, so
the master is 512 rather than an upscale to 1024 that would add bytes and no
detail.

**Maskable is its own file**, not the 512 listed twice as it had been. Android
crops maskable icons to whatever shape the launcher likes, so the emblem is
drawn at 72 % there against 96 % for the plain tile — at 96 % a circular crop
takes the tips off the arms.

**The navy field is knocked out.** The artwork's own navy (`#000d70`) is
lighter than the app's (`#06131f`), so at first the logo read as a rectangle
pasted onto the page. Both masters now have that field flood-filled to
transparency from the border inward — not a global colour replace, so it stops
where the artwork starts — with alpha ramping across the boundary, because the
source is a JPEG and a hard threshold leaves a dark fringe tracing every
outline. With no field of its own the logo takes the colour behind it, which is
what makes it work on both the flat page and the header's blur. The flood does
reach the emblem's interior navy — ring, boat, waves connect to the outside
through the gaps between the arms — which reads correctly on this app's dark
background but means the assets assume a dark surface.

**Launcher tiles stay opaque** on `#06131f`, since a launcher shows its own
wallpaper through transparency, and `theme_color` and `background_color` are
that same value. Installed icon, install splash, system bars and app are one
continuous shade rather than three near-misses of navy. `APP_BG` in the script
has to move if the app background ever does.

**Precache kept lean.** The 512 icons are excluded — the operating system
fetches those at install time, not the page, so caching them only added 300 KB
to what a crew downloads over cellular. 749 KiB rather than 1.1 MB.

Verified in a browser at 390 px: logo and emblem both decode and render with no
visible field on either surface, launcher tiles are opaque on the app
background, and every asset plus the manifest serves 200. Tests unchanged at
174; typecheck, lint and build clean.

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
