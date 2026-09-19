# CLAUDE.md

Project-specific instructions for Claude Code when working on this repository.

NavMate is a static single-page app (Vite + React 19 + TypeScript) backed by
Supabase, served at `navmate.stationinsight.com`.

**Two apps, two addresses, one database.** `navmate.stationinsight.com` is this
repo — the field PWA a crew installs on a phone. `rescuegps.stationinsight.com`
is the RescueGPS command system (`jcochran6810/rescuegps-navigator-pro`,
a separate repo and Vercel project). They share the Supabase project
`ekhvfypxuxskjglwwoqh` and nothing else; that database is the only seam between
them, and `supabase/migrations/README.md` explains how it is kept safe. Both
are subdomains of `stationinsight.com`, which otherwise belongs to Station
Insight on the `bunker-gear` project.

NavMate hardcodes no hostname anywhere: the auth redirects use
`window.location.origin` and the PWA manifest's `start_url`/`scope` are
root-relative, so the app is portable across origins. What is NOT portable is
an **install** — a PWA belongs to the origin it came from, along with its
cached waypoints, queued writes and saved chart tiles.

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
  is unambiguous. **`src/components/CoordInput.tsx` is the one place a
  coordinate is typed** — Waypoints, the waypoint editor, the LKP card and the
  Chart tab all use it. It never parses anything itself: each format lays out
  its own boxes and joins them into a canonical string `parseCoord` already
  accepts, so the strict rules keep firing and there is no second parser to
  drift. Keep it that way. (The Convert tab is deliberately not a caller — it
  is a converter showing three formats at once, not a position picker.)
- **A leg completes two ways, and the second one has a condition on it.**
  `src/lib/steer.ts` advances when the boat is inside the arrival circle (a
  crew setting, 50/100/150 ft, floored at the fix's own accuracy) **or** when
  it has passed abeam of the mark *and is still heading down the leg*. That
  last clause is load-bearing: the function used to refuse a plane-crossing
  test outright so that "a boat that has to abort a turn and come round again
  should be given the same point back". The heading check is what preserves
  that, and `steer.test.ts` holds both cases so the reasoning cannot be lost.
- **`src/lib/routing.ts` prefers marked channels, and the cost must never dip
  below 1.** `astar`'s octile heuristic is admissible *and consistent* only
  while every step costs at least 1; the closed-set pruning depends on the
  second. So a preference is always a penalty on the cells you want avoided,
  never a discount on the cells you want used. Two words to keep apart in that
  file: **edge** means the bank of navigable water (a geometric proxy),
  **channel** means a charted DRGARE or FAIRWY. They were once both called
  "channel" and it made the file unreadable.
- **Supabase keys are compiled in on purpose.** `src/lib/supabase.ts` falls
  back to the project URL and publishable key. Both are publishable; RLS is
  the security boundary. Never add a service-role key to this repo.
- **RLS is the security model.** Any schema change needs matching policies in
  a migration under `supabase/migrations/`, applied to project
  `ekhvfypxuxskjglwwoqh` ("RescueGPS"). `anon` must have no policy on any
  table.
- **The database is shared with the RescueGPS command system.** Read
  `supabase/migrations/README.md` before touching schema. Three rules follow
  from it: the `20260803`–`20260806` migrations are history and must never be
  replayed here; `profiles` belongs to both applications, so NavMate reuses it
  and never alters it (NavMate's `callsign` is that table's `call_sign`, and
  teammate names come from `navmate_team_profiles()` rather than a policy);
  and NavMate-internal helper functions are prefixed `navmate_` so they cannot
  silently replace a same-named function of the command system's — which is
  exactly what `create or replace function handle_new_user()` would have
  done.
- **`incidents` is shared with the command system**, as of migration
  `20260913041316`. NavMate writes the same table the command dashboard
  subscribes to. Two rules follow: never `select('*')` from it — it carries
  ~50 columns including `incident_password_hash`, and NavMate's cache is
  persisted to localStorage, so the column list is named explicitly in
  `src/store/useIncidents.ts`; and NavMate filters on `client_id is not null`,
  because a command-created incident is not something the field app has a UI
  for.
- **The compass reads true north, and that is not cosmetic.** `src/lib/geomag.ts`
  is the World Magnetic Model (WMM2025) evaluated on the device, checked against
  all 100 of NOAA's published test values in `geomag.test.ts`. Every bearing
  elsewhere in NavMate is true, worked from coordinates; a magnetometer is
  magnetic, and on either US coast those differ by 10–20°. Two conventions on
  one screen is how a crew ends up steering 15° off, so the dial is corrected
  rather than captioned with a warning. The model expires in **2030** —
  `modelValidity()` says so on screen, and replacing it means swapping the four
  coefficient tables for the next release. Do not "simplify" it to a dipole: the
  non-dipole field is exactly the part that matters near a coast.
- **A phone compass is not `360 - alpha`.** `src/lib/heading.ts` builds the full
  rotation matrix and picks what counts as "pointing" from how the phone is being
  held — the top edge of the screen when it is flat, the back of the phone when it
  is held up to read — because `alpha` is the azimuth of the top edge, and a phone
  held up has its top edge pointing at the sky where every direction is the same
  direction. The band between the two holds is placed where the two answers agree,
  so crossing it moves nothing. There is one unavoidable 180° flip, at top-edge
  pointing straight down, and it is put where nobody holds a phone. Screen
  rotation is part of this, not a correction bolted on after.
- **"The readings keep changing" is both a broken magnetometer and a turning
  boat.** `headingWander` fits a straight line through the recent readings and
  reports the residual, so a turn at any rate fits the line and a jittering sensor
  does not. The first version measured how far the readings moved and called a
  hard turn a fault — the browser drive is what caught it.

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

### 2026-09-19 — claude/youthful-knuth-t4hzoo (a photograph of the real thing, twice)

A second screenshot, this time of NavMate itself running on the phone, with
two faults circled by the words: "Move the degree bearing read out to below
the compass. It is blocking the users dot location and the range display.
Also extend the range display to the edge of the screen."

**The bearing was sitting on the crew.** Thirty-eight pixels of digits in the
middle of the dial — and the middle of the dial is where they are standing, so
it covered their own position marker and the nought of the range scale.
`CompassRose` omits its centre digits and caption over a map now, and whoever
placed the map there draws them underneath in ordinary text. Still the largest
thing on the card, because it is the number that gets read out over a radio.

**The scale stopped two-thirds of the way up.** Its length was
`min(w, h) / 2` — half the smaller side of the map, which has nothing
whatever to do with how far there is to go in the direction the crew is
facing. `rulerLengthPx` is a ray-box intersection along that direction, with
a margin that keeps the arrow head and the last label inside, and the
graduations follow it out.

That changed what a good spacing is. `pickRings` had taken the **coarsest**
step that fitted three rings, which was right when the scale was three rings
and wrong the moment it reached the screen edge: a long ruler divided into
three is one nobody can interpolate on. It takes the finest readable step now,
up to six graduations.

**Three notes on the checking, because two of the three were failures of the
checks rather than of the code.**

1. The reach check was **worthless as first written**. Centred on this map,
   half the smaller side happens to equal the distance to the top edge, so it
   passed against the old formula too. It pans the boat 90 px down now, which
   separates them: 19 px from the edge with the fix, **107 px short without**.
2. A new test for the ray-box maths was wrong about its own geometry — from
   the centre of a 300 × 260 box, 45° up and to the right reaches the *side*
   first, not the top. The code was right and the test was corrected.
3. Two existing ring tests encoded the old "exactly three" contract and were
   rewritten rather than patched, because the contract itself had changed.

**And the stale-`dist/` trap for the fourth time this session**, again during
a falsification, again because the build failed on an unused import while the
drive happily reported green against the previous bundle. Worth stating as a
rule rather than an anecdote: **a drive that reports green after a failed
build is reporting on the last good build.** Read the build output, not the
drive's exit code.

**Verification.** 681 tests, up from 675. The compass drive is 62 checks, up
from 60, and both new ones fail with their mechanism removed. Drives green at
74 (chart), 62 (compass), 35 (map menu), 29 (waypoints), 25 (search), 15
(datum), 11 (mobile).

### 2026-09-19 — claude/youthful-knuth-t4hzoo (one north, and a photograph that settled it)

"The map and the compass is just slightly off", with a screenshot of the app
to copy and the blue dot marked. Four corrections, and the first one explains
the complaint.

**The dial and the ground had different norths.** The map turns by the true
heading, because the ground is laid out from coordinates; the dial kept
whatever reference the crew had picked. With magnetic selected its N sat a
declination away from the map's, and two norths a few degrees apart on one
screen is what "slightly off" looks like from a boat.

The previous session's entry argued this was *correct* — the tops agree, and
a paper chart prints a magnetic rose inside a true one. That reasoning is
sound about a paper chart and wrong about this screen: on paper the two roses
are drawn as two rings and nobody mistakes one for the other; here they are
one dial over one map, and the only way to read them is as one thing. So the
dial reads **true whenever there is ground under it**, and the reference
toggle is hidden rather than disabled in that mode — a control that is
present and inert is a question a crew stops to answer. The toggle still
governs the bearings table below, where there is no ground to disagree with.

**The black circle behind the bearing is gone, and so is the dial's face.**
Two discs were covering ground: the face and the hub the digits sat on.
Legibility comes from outlining the marks now — white graduations, a dark
stroke on every number — rather than from tinting what is underneath. The
check counts filled discs inside the dial rather than inspecting one of them,
so putting either back goes red.

**Range rings became a ruler along the way the crew is facing**, as in the
photograph: a graduated line from the boat, five minor ticks to a step, the
distance beside each graduation, a nought at the boat and an arrow at the far
end. Rings answer "how far is something in any direction", which is not the
question anyone on a bearing is asking, and three circles drawn over a chart
hide the chart. One line of ground covered instead of three rings of it.

**Centre-on-me can be found and pressed.** The map's control stacks were
underneath the dial's overlay. They sit above it now, and the button carries
a crosshair as well as the word, because on a map with a rose drawn over it
the shape is found faster than the label is read.

**On asking rather than guessing.** The Play Store listing for the app to
copy is blocked by this sandbox's egress proxy. Rather than build to a guess,
the question went back with the options — and the answer ("the dial belongs
on the map, not beside it") changed the shape of the page. The screenshot
that followed settled four more things no amount of reasoning would have.

**Verification.** 675 tests. The compass drive is 60 checks, up from 56, and
each of the four new ones fails with its mechanism removed — the falsified
dial reads "SSW · Magnetic" where the fixed one reads "S · True", which is
the reported fault reproduced on demand. One older check was rewritten rather
than kept: it counted three graduations and went red the moment the ruler
gained its nought, the label that makes it a ruler rather than a set of
rings. Drives green at 74 (chart), 60 (compass), 35 (map menu), 29
(waypoints), 25 (search), 15 (datum), 11 (mobile).

**Left deliberately different from the screenshot**, and said to the user
rather than silently matched: their rose sits at the bottom of the screen with
the position separate and higher up, where NavMate centres the dial on the
boat so the dial and the ruler share an origin; and they print coordinates
over the map, which NavMate already shows on Home and in the waypoint sheet.

### 2026-09-19 — claude/youthful-knuth-t4hzoo (a waypoint you can tap, and the dial on the ground)

Three more rounds after the phone testing, each one arriving as a short
sentence and turning into a structural change.

**"When looking at any waypoint the user should be able to click on it and
have the option to navigate here."** A waypoint appeared in six places and
meant something different in each: the Waypoints tab had the photographs, the
nearest-four on Home had a range, the bearings table had a bearing, and the
marker on the tracker map had nothing behind it at all. There is one sheet
now and all four open it — position in the crew's format, range and bearing,
who saved it, the note, the photographs, and **Navigate here** as the primary
action.

It opens **by id, not by value**, so a waypoint a teammate edits while it is
open updates and one they delete closes the sheet rather than showing a copy
of something gone. Navigate goes through the same seam a long press on the
chart uses, so there is one route into the plotter. And a marker only opens a
waypoint when it *is* one: `PathMarker` carries an optional `waypointId`
rather than assuming its id is a waypoint, so a tap on START opens nothing —
while a tap on the chart in pick mode still picks, because a crew part-way
through choosing a destination means the place under their finger.

**"Add a button to show the satellite, hybrid and chart maps under the
compass, locked into the rotation of the compass… then range rings."**

The map turns by the **true** heading, never the one on the dial. The dial can
be showing magnetic if the crew asked for it, and the ground is laid out from
coordinates. Turning a true map by a magnetic heading leaves it wrong by the
declination — the exact error the compass work removed. The drive shows it:
at heading 0 the ground sits at 14°, which *is* the local declination.

**A turned map needs two frames and every gesture crosses between them.**
`project`/`unproject` work north-up the way the tiles are laid out; a finger
touches the screen frame. A drag is turned before it is applied, a pinch
resolves the ground under the fingers through the rotation, and a tap comes
back into the map frame before it becomes a position. The drive measures it
by watching the boat: 0, 80 px for a drag of 0, 80 on a map turned 174°, and
**-8, -80 with the rotation removed**. The tile layer grows to the exact
bounding box of the rotation, because a turned rectangle leaves wedges of
nothing in the corners of the one it came from; at 0° not one extra tile is
fetched. The scale bar, the rings and a new north arrow stay outside the
rotating group, and every label is turned back so it reads upright.

**"Function needs to work like this app"**, with a Play Store link. That
listing is blocked by the sandbox's egress proxy, so rather than guess at an
app that could not be seen, the question went back with the options. The
answer changed the shape of the page: **the dial belongs on the map, not
beside it.**

So `CompassRose` gained `overMap` (the opaque face becomes a wash — an opaque
instrument over a chart is a lid), `Compass` gained `behind`, and
`SatelliteMap` gained `overlay`. `behind` is a **function**, not a node: it
hands the rose to whatever is behind it to place *inside* that thing's own
box. The first version wrapped the map, so the rose centred itself on the
whole component — attribution row included — and sat low and over the edges.
The rose is no longer forced square either; the SVG letterboxes itself, which
is what `preserveAspectRatio` does, and the forced square had been shoving the
dial four pixels off centre.

Worth recording because it looks like the thing CLAUDE.md warns about and is
not: with magnetic selected there are two norths on the screen, the dial's and
the map's, a declination apart. The **tops** agree, and the top is what
"ahead" means. A paper chart prints a magnetic rose inside a true one for
exactly this reason.

**Two more things a browser caught that reading the code would not.** The
range rings drew *nothing* at compass zoom: the smallest whole-unit step was a
twentieth of a nautical mile — 278 m of screen for three rings where there is
room for about 140. The ladder starts in feet now, metres for a crew reading
kilometres, because at a hundred yards nobody says "0.05 nautical miles". And
`pickRings` refuses when the innermost would be under 16 px, which its own
"draws nothing rather than inventing a spacing" test found: zoomed far enough
out every step fits, as a circle a fraction of a pixel across.

**The stale-`dist/` trap appeared twice more** and was caught both times by
reading the build output rather than the drive's exit: once on an unused
symbol during a falsification, once on a JSX-style comment sitting in a
JavaScript argument. A drive that reports green after a failed build is
reporting on the previous build.

**Verification.** 675 tests, up from 658 (`rings.ts` is the new pure
function). Eight drives: 74 (chart), 56 (compass), 35 (map menu), 29
(waypoints), 25 (search), 15 (datum), 11 (mobile). The new checks measure
arrangements rather than assert elements exist — the rose is inside the map
box and centred on it to within four pixels; the same waypoint opens from a
list on one screen and from its marker on another, and the marker half fails
with `waypointId` removed while the list half stays green.

### 2026-09-19 — claude/youthful-knuth-t4hzoo (the drives had never used a finger)

Asked to test on a phone after the session had already merged. That is not
something this environment can do — there is no device here, and an installed
PWA belongs to the person holding it — so the nearest honest thing was done
instead: the shipped build driven under **real touch input**, dispatched
through CDP the way Chrome does on a device, with `isMobile`, a pixel ratio of
3 and an iOS user agent.

It immediately broke the feature this session opened with.

**Press and hold was unusable on a touch screen.** A touch that ends produces
a compatibility mouse sequence — mousedown, mouseup, **click** — aimed at
whatever is under the finger at that moment. The press menu opens *under the
finger* by design, so the click landed on one of its own items and fired it.
The event log shows the menu opening, "Save as waypoint" firing on release,
and the next tap landing in the sheet it had opened. On a phone a crew would
press the chart and get a waypoint sheet, never a menu.

**Every check on that feature had passed** — 29 of them — because a mouse does
not generate that click. That is the lesson worth keeping from this round: a
drive at phone width with a mouse tests layout and logic, and says nothing
whatever about a gesture. `scripts/drive-mobile.mjs` exists now so the next
gesture gets tested as one.

The fix swallows the first click after the menu opens, in the capture phase,
before React sees it; the guard lifts on that click or after a moment, so a
real tap on an item — which needs a new touch — still works. Both touch checks
fail with it removed. That falsification was itself wrong the first time: the
build failed on an unused symbol, the drive ran against a **stale `dist/`**
and reported green. Same trap the log records from two sessions ago, caught by
reading the build output rather than the drive's exit code.

**Fourteen controls were too small for a thumb** — Add waypoint, Refresh, See
all, Save imagery for offline, the waypoint card's actions, Show all upcoming
turns — all 26–27 px tall. They are 36 px now. iOS asks for 44 pt; 36 is what
these layouts hold without pushing the content a crew came to read off the
screen.

Also checked, and fine: no section scrolls sideways at phone size, nothing
tappable sits under the home indicator (the stamp button clears it by 16 px,
the full-screen map by 73), a few pixels of hand-wobble during a press is
still a press, and a drag is still a pan.

**Stated plainly: this is emulation, not a phone.** Four things remain
unanswerable here and are in `fix_list.md` — the magnetometer, iOS Safari's
own `requestPermission` gate, the service worker's offline path, and the tide
toggle, which has still never rendered because NOAA is blocked from this
sandbox.

### 2026-09-19 — claude/youthful-knuth-t4hzoo (a long list, and three bugs inside it)

A session of requests arriving faster than they could be finished, so they were
tracked and worked in order. Eleven of them; three turned out to be bugs
wearing a feature's clothes.

**Press and hold on any map, and a full-screen map.** Every map answers a press
with the position under the finger — the crew's own coordinate format, range
and bearing from the boat — and the two things anyone does with a place they
have just spotted: keep it, or go to it. `MapActionHost` carries the request
out because neither can be done from inside a map: the waypoint sheet contains
a map, so importing it would be a cycle, and navigating changes the tab, which
is `App`'s state. Full screen is a fixed overlay, deliberately **not** the
Fullscreen API — iOS Safari implements it on video only, and a control that
does nothing on the target platform is worse than none.

**The compass starts itself, and the reason it did not is the interesting
part.** `requestPermission()` rejects outside a user gesture, and that
rejection was caught and stored as `denied` — the same state as a person
refusing. So the screen showed a refusal before anyone had been asked, and
needed a button to ask properly. `needs-gesture` is now its own state; the
compass asks on mount, which normally lands inside the transient activation of
the tap that opened the screen, and when it does not, the next touch anywhere
is armed instead of putting a button on the screen.

**Joining a search that is already running**, which `fix_list.md` had carried
as "deliberately not built" since the tables merged. The list is sorted by how
far the search is from the boat, because an incident 300 miles up the coast and
the one in this bay are otherwise two identical lines of text. The password is
checked in the database — `navmate_join_incident` compares inside a SECURITY
DEFINER function and answers with one word, so the app never holds a password
or a hash. An approval search files a request with the IC rather than refusing.

**And everyone on a search can see everyone on it.** This boat's fixes go to
`asset_tracks` — the command system's own telemetry table, so their dashboard
gets them too — and the other units come back with the name they answer to on
the radio, drawn on all three maps and listed with range and bearing on the
incident card. A unit that stops reporting is faded and labelled rather than
removed: a marker vanishing reads as "they have gone", when the truth is
almost always "their phone lost signal". Positions are perishable, so the
offline rule here is deliberately not the waypoint queue's — a bounded buffer
that drops the oldest first and never blocks a capture.

Reading a teammate's position was previously impossible for a field responder
(`asset_tracks_select_scoped` allows your own rows plus command staff), which
is why this needed a policy and not just a query. Migration `20260919000000`,
additive only.

**Three bugs, each found by following a complaint to its cause.**

1. **A new incident inherited the last one's records.** The datum worksheet and
   the pattern page filtered by team and nothing else, so the LKP, the
   conditions, the drift markers and their countdowns carried into the next
   search — a fresh incident opening onto a datum computed from a finished one.
   `recordsForSearch` is the rule, with tests.
2. **A teammate's waypoint photograph could never be read.** The storage
   policy's team clause said `w.id::text = (storage.foldername(w.name))[2]` —
   the waypoint's *title*, because inside that sub-select the bare `name`
   resolves to the `waypoints` row and shadows `storage.objects.name`. A title
   has no path separators, so the subscript is null and the policy collapsed to
   "your own photographs only". Nothing reported it: a signed-URL request for
   an object RLS hides comes back as an ordinary not-found, and the tile said
   "offline" for every failure, so a crew with full signal saw "offline" on
   every photograph somebody else had taken. The tile now says which failure it
   is, which would have pointed straight at the policy.
3. **The selected team reset on every refresh.** On the first render `session`
   is null because auth has not restored yet — not because anyone signed out —
   and treating that as a sign-out ran `useTeams.reset()`. The load that
   followed found `activeTeamId` already null, decided the stored selection was
   stale and **deleted it from localStorage**.

**The rest, briefly.** Victim details write the command system's own `victims`
table, keyed on the incident, with every option read off the live CHECK
constraints first — `''` satisfies none of them, so a blank choice written as
an empty string is an insert the database refuses, and a refused op stops the
queue behind it. Teams within ten miles are listed from their own recent work,
returning **a range and never a position**, and the six-character code is still
required — the list is confirmation, not a way in. "Invite teammates" copies a
link carrying the code and hands off to the phone's own Messages or Mail;
`?join=CODE` is read once on open and stripped. The steering card gives an
instruction — "come left 97°" with an arrow — and counts down the distance and
time to the turn, with the whole remaining pattern available as a table
measured from the boat. The survival clock is a footer banner on every screen,
asking for nothing: water temperature from the conditions, time in the water
from the LKP, life jacket from the victim description, and no banner at all
when any of those is missing. And **Settings** now owns every unit — depth,
distance, speed, temperature, height — converting at the screen boundary only,
because `water_temp_c` and `draft_m` are contracts rather than preferences.
The chart can add the predicted tide to its depths, saying every time it does
that the route itself was planned at chart datum and has not changed.

**Verification.** 658 tests, up from 618. Six drives green: 74 (chart), 44
(compass), 29 (map menu), 29 (waypoints), 25 (search), 15 (datum). Two new
drives, and **four of their own checks were wrong first**, each caught by
reading a failure rather than the code:

- the tracker map sits below the fold, so every press in the first version of
  the map drive landed off screen and two "nothing happened" checks passed for
  the wrong reason. It asserts the map is inside the viewport before pressing
  anything now;
- the Stat cards render their labels upper-cased, so `/Legs (\d+)/` matched
  nothing and read exactly like a value that had not changed;
- the re-plan check used a spacing change, which is clamped into a leg count
  and can legitimately produce the same shape — a check that cannot tell "the
  plan did not change" from "the steering did not follow it" is testing
  nothing. It switches pattern type now, and fails with its mechanism removed;
- the turn check passed on "Steady — on the leg", which is what the card says
  when the boat happens to be pointing at the mark. The boat is walked across
  its own leg now and the card has to name a side and a number of degrees.

Everything touching the database was verified against it as real accounts,
including the refusals: a wrong password leaves the requester a
non-participant, B sees 0 of A's tracks before joining and 2 after, a track
belonging to no incident is never shared, and the old photo predicate returns
false where the fixed one returns true. **One check in that set was invalid and
is recorded rather than counted**: the second test account is this project's
platform admin, so "cannot read the teams table" was answered by the
`platform admin read` policy rather than by a hole.

**Still open**, in `fix_list.md`: `incident_participants` still allows a
hand-made self-insert (their policy, not NavMate's); `victims` is readable by
every signed-in user for the same reason; the tide toggle has never rendered
because NOAA is blocked from this sandbox; live sharing has only met one
device; and the Live tracking and ETA tabs still carry their own distance
pickers alongside the new Settings.

### 2026-09-14 — claude/navmate-compass-feature-hf4h6z (a waypoint can be added from wherever they are read)

"Anywhere there are waypoints listed add a button to add another waypoint and
give the option to input the coordinates (drop down menu for different
formats) or choose on map."

Every list of waypoints in this app is somewhere a crew is already thinking
about one — the bearings table, the nearest-four on Home, the chart plotter's
destination picker — and the only place one could be **made** was the Waypoints
tab. Noticing a gap meant leaving the screen that showed you the gap and coming
back to find your place again.

`AddWaypointButton` (`src/components/AddWaypoint.tsx`) now sits on all six:
Home, the compass bearings table, the compass pointer picker, ETA, the
live-tracking map and the chart plotter's waypoint sheet. On the pointer picker
it renders **even with nothing saved**, because an empty list is exactly when
one is wanted.

**Nothing in it is a new mechanism, and that is the point.** The typing is
`CoordInput`, so the DD/DDM/DMS selector, the hemisphere rules and every
refusal `parseCoord` makes still fire — there is no second parser, which
`CLAUDE.md` has asked for since that control was built. The map is
`SatelliteMap`'s own `onPick`, the one the chart plotter uses. The Waypoints
tab already had a full creator, so what it gained is the map: its stand-alone
"Use my location" moved **inside** `CoordInput` next to a new "Choose on map",
which is how the LKP card and the chart already read.

**The load-bearing detail is scope.** Every one of those lists filters on the
active team, so a waypoint saved private while a team is selected would be
created successfully and *not appear in the list it was added from* — which
reads as a save that failed. The scope is read from the same store the lists
read rather than passed in by the caller, so no call site can get it wrong.

**A correction to the request worth recording:** the format chooser is the
app's existing **segmented** control, not a dropdown. Making this one a
dropdown would have made it the only coordinate field in NavMate that is one.
Said to the user rather than silently substituted.

**Verification is `scripts/drive-waypoint-add.mjs`, 29 checks**, because none
of this is unit-testable — it is a control placed in six render trees and a
sheet that writes to a store. It drives the button on every screen, types a
position, has 95° of latitude refused, switches format and checks the value
survives the switch, taps the map and checks the result is north **and** west
of the fix (both axes: swapping them is the classic unprojection bug and a
longitude-only test walks straight through it), and opens the sheet from
*inside* the chart plotter's own sheet to prove Escape does not strand the
crew.

**Three of its own checks were wrong first, and each was caught by breaking the
mechanism on purpose rather than by reading it.**

1. `/Waypoints/i` as a menu regex matched **Home**, whose hint ends "…nearby
   waypoints" — menu items are named by label *and* hint. Four sections were
   silently testing Home. Every selector is anchored to the label now.
2. "No map until it is asked for" was `count() >= 0`, which is true of
   everything.
3. The list-visibility check searched the whole page, and **passed with the
   scope deliberately broken** — it was matching the success toast, which
   carries the waypoint's name. Scoped to the list, it now goes red with the
   scope wrong, which is the whole hazard the feature was designed against.

A fourth was caught the same way: removing a button to falsify a check left an
unused import, `npm run build` failed, and the drive ran green against a
**stale `dist/`**. Same lesson as the deploy two sessions ago, in miniature:
check that the thing you are testing is the thing you built.

**Verification.** 618 tests (unchanged — this session added no pure functions),
typecheck, lint, build clean, and four drives green: 29 (waypoints), 44
(compass), 74 (chart), 15 (datum).

**Not verified.** The sheet has only met a simulated receiver and stubbed
tiles, like everything else here. One cosmetic note for whoever is next: the
map inside the sheet carries `SatelliteMap`'s own "Save imagery for offline"
button, which is off-task in a point picker. It is an explicit tap and clearly
labelled, so it was left rather than given a new prop.

### 2026-09-14 — claude/charming-rubin-rlz3ks (two clocks, and a browser catching what 600 tests could not)

**"Add a time in water and last seen alive to the search datum page. This is
important for calculating drift instead of when the incident was created."**

A correction to the premise first, because it changed what needed fixing:
drift was **not** running from the incident's creation time. `computeDatum`
already used the LKP time the crew types. What was missing is that one time was
being asked to answer three different questions — when the object was at the
LKP, when it went into the water, and when it was last known alive — and
`incident_time`, whose meaning on the command side is literally "went into the
water", was only ever *derived*: copied from the first LKP, never enterable.

Both fields turned out to have first-class homes on the shared table already —
`incident_time` and `time_last_alive`, checked before anything was designed —
so this needed **no migration and invents no column**.

**The rule for which clock drift runs on is the load-bearing part.**
`driftStartsAt` takes the **later** of the LKP time and the time in water:

- Entered the water *before* the LKP — a witness saw them later, further down.
  The LKP is the newer fact and already contains that first stretch of drift.
  Running from entry counts it twice and pushes the datum **past** the object.
- Entered *after* the LKP — a vessel's last position is known and it sank an
  hour later. Nothing was drifting in between, and an hour charged to it is an
  hour of search area invented.
- Seen going in, the usual case: identical, and the rule is a no-op.

The tempting version — "use the time in water whenever it is given" — fails the
first case, and two tests fail against it. The same rule now governs the
handoff's `hours_adrift`, which had `incident_time ?? lkp_time`.

**Last seen alive is recorded, shown and handed on, and deliberately does not
touch the survival arithmetic.** The USCG table is driven by immersion time; a
later sighting means the person beat the estimate, not that the estimate should
move. The field says so under the input rather than leaving a crew to wonder.

---

**"Add a 5 minute countdown after a datum marker is deployed, and a Record
drift at this location button next to Retrieve here."**

A marker can now be read **without pulling it out**. Each reading measures the
leg from the **previous** point — deploy, or the reading before it — not from
deploy every time. That is the whole reason to take them repeatedly: a tide
that has turned shows up in the latest leg and is buried in the average since
deploy. The average is what "Retrieve here" still gives, and the two answer
different questions.

The timer **never records anything by itself**, which is a decision rather than
a gap: a reading only means something taken alongside the marker, and a fix
grabbed automatically from wherever the boat happens to be would measure the
boat's drift. So it counts, turns amber when due, and waits. It is its own
component so the one-second tick re-renders a line of text rather than the
whole Datum tab.

**Two refusals guard the same door** — a reading reaches the datum through "Use
as current", so a number invented here becomes a search area centred in the
wrong place:

1. A leg shorter than the fixes that measured it is receiver noise, not a slow
   current. A ±10 m error on a 15 m leg swings the bearing by tens of degrees.
   Scaled to the accuracy the receiver reports, and it says "leave it longer".
2. A drift faster than water moves is a jumped fix or a position taken under
   way. The ceiling is **20 kn**: past anything the sea does, short of anything
   a bad fix produces, and clear of the 6–8 kn a spring tide really runs.

**The second was not designed in — the browser found it.** Driving the app
produced **"drift 180.53 kn"** and nothing stopped it, because the drive
teleported the boat, which is exactly what a stale fix looks like to this code.
That is the second time in three sessions a browser has caught what the unit
tests could not, and the reason the Datum tab now has a drive at all:
`scripts/drive-datum.mjs`, **15 checks**, offline, deploying a marker, watching
the countdown tick, recording a believable leg (~50 m over ~20 s ≈ 3.7 kn),
seeing the timer reset, being refused a second reading from the same spot, and
following both worksheet buttons across tabs. It takes half a minute of wall
clock **on purpose**: a drift reading is a real displacement over real elapsed
time, and teleporting the boat to save twenty seconds tests neither refusal.

One of its checks was rewritten after it failed for the wrong reason — it
looked for a toast that had already gone, where what matters is that no reading
was written.

---

**"In the search around here field, add a Take me there button, and a Begin
search pattern button after Take me there is selected."**

Both live on the datum, in the order the two moves happen. "Take me there"
hands the datum to the chart plotter as a destination and switches to it;
"Begin search pattern" appears only once that has been asked for, because a
pattern is steered from where you arrive and planning a sweep around a datum
you are still a mile from plans the wrong sweep.

Tab state is local to `App`, so `useGoTo` is the seam — a place one screen
leaves for another, **consumed once**, so a destination the crew then edits by
hand is not silently overwritten on the next mount. Not persisted: it is a
gesture in one sitting, and everything that must survive a reload is already a
`sar_records` row.

---

**"Nothing shows up on the command side when an incident is handed off."**
Investigated and **not a NavMate bug**. The incident `INC-260913-HHF98` is in
the shared table, active, flagged field-created; running the command app's own
query (`select * where status in ('active','suspended')`) as that signed-in
account returns it **first**, alongside their four. Their code has no
organisation filter and no participant requirement, and their mapper handles
NavMate's rows. Signed out, the same query returns **0 rows for everything**.

So it is client-side on the command app, and the leading explanation is the one
from the previous session: the stale NavMate service worker on
`rescuegps.stationinsight.com` means they may not have reached the command app
at all. The other two candidates are not signed in, or `VITE_SUPABASE_URL`
unset on that deployment (their client has no fallback and goes to demo mode).
Their console distinguishes all three — it prints
`[supabase] incidents.list returned N incidents`.

**Verification.** 618 tests, up from 602. The drift-clock rule and both leg
refusals were each confirmed to **fail with their mechanism disabled** (the
naive "always use time in water"; legs always measured from deploy; no noise
floor). Drives green at 74, 44 and 15.

**Still open.** The chart work has *still* never run in a browser carrying it —
with deploys green, the next replot is the first real test of the relay, the
failure reporting, the `f=json` fallback and the S-57 names together. And the
datum screen's new refusals have only met a simulated receiver.

### 2026-09-14 — claude/charming-rubin-rlz3ks (Fahrenheit, S-57 names, and a deploy that was never happening)

**The thing that reframes the last two sessions: nothing had been deploying.**
A parallel session found it — `vercel.json` carried a `"//"` comment key added
during the ENC relay work, Vercel schema-validates that file, and a rejected
file *fails the deployment* rather than falling back. Every production deploy
from `ae40ebe` onward was ERROR. Production sat on `fb0ece7` throughout.

So the report that closed the last session — "I replotted, still a straight
line" — **was not evidence about the fix**. That plot ran against a build made
before the ENC relay and before every chart change since. The giveaway is in
the screenshot: its wording ("…has no charted depths for this area … expected
outside US waters") does not exist anywhere in the current source. Worth
recording as a rule rather than an anecdote: **before reading a field report as
a verdict on a change, confirm the change is in the build being used.** Checking
the Vercel deployment state is now a step in the end-session protocol's
verification rather than an assumption.

**The layer names, which is the strongest remaining explanation.** ENC is
published from S-57, whose object classes are six-letter codes. `ROLE_PATTERNS`
matched readable English only — and `WRECKS` reads as "wrecks", `BRIDGE` as
"bridge", so those two matched *by accident* while `DEPARE`, `DRGARE`,
`LNDARE`, `FAIRWY`, `OBSTRN` and `PILPNT` every one missed. Enough layers
matched to clear the old `layers.length === 0` gate; not one of them carried a
depth; the result came out as "no charted depths for this area" about the
Houston Ship Channel.

Both spellings match now. The gate also asks a better question: a layer
catalogue is a property of the **service**, not of the water, so a catalogue
with no recognisable depth layer is always NavMate's problem and never
geography. The `no-layers` error now names every layer the service actually
published, so one photograph of the screen ends this for good.

**Water temperature reads in Fahrenheit.** The stored column stays
`water_temp_c` and stays Celsius — it is a contract with the command system
(incident handoff, `field_drift_data`, `simulate_drift_params`) — so `cToF` and
`fToC` convert at the screen boundary only, on **read as well as write**.

The read path is the whole risk. `DatumTab` seeded its box straight from
`water_temp_c`, so under an °F label a record saved at 21 °C would have shown
"21 °F" — shirtsleeves rendered as a survival window of minutes. And
`SearchTab` had one variable, `temp`, carrying a typed value on one branch and
a stored value on the other: two units under one name, which is how this
happens. It is `tempF` now, converted once where the model is called. Eight
tests fail with the conversion removed.

**Jumper / long fall in, Jet ski out.** `incidents` is shared, so the **live
CHECK constraint was read before the picker was touched** — it had no `jumper`,
and offering a code the database refuses would have failed at sync and stalled
the whole offline queue behind it, which is the failure mode CLAUDE.md warns
about. Migration `20260914000000` widens the CHECK (widened, never narrowed: no
existing row invalidated, no command-system path broken), applied and verified.
`jetski` leaves the picker but stays in `RETIRED_TYPE_LABELS`, because the code
is in rows already written on both sides — retiring a choice is a decision
about what to offer next time, not about what happened last time.

**"Choose on map" for the LKP.** A tap records the position as **estimated**
(±2.5 NM), never `gps`: `position_error_nm` feeds the search radius, and
calling a finger on a chart ±0.1 NM would shrink the area actually searched
around a position nobody measured.

**The compass is live on opening the page.** No Start button — a dial behind a
button is a step asked of someone who has already said what they want. iOS
keeps one tap because it only grants the sensor from a real user gesture;
`headingNeedsTap()` tests for that gate rather than sniffing the user agent, and
where it exists the control is worded as the permission prompt it is. The
sensor stops on unmount, which is what the removed Stop button was for.

**The domain question, answered and not a settings problem.** Verified against
the Vercel API: `rescuegps.stationinsight.com` is on `rescuegps-navigator-pro`
(production READY) and `navmate.stationinsight.com` is on `rescuegps-navmate`.
Both correct. The old address serves NavMate because **NavMate's service worker
is still registered on that origin** from when NavMate was served there, and a
service worker serves its own cached shell regardless of what the server now
returns. Neither repo can evict it — the command app never gets to run. Device
-side cleanup (clear site data for that origin); a hard reload will not do it.
This is the same lesson as `MovedNotice`, from the other direction: an origin
move leaves state behind that nothing shipped afterwards can reach.

**A premise of mine, corrected by the user's numbers** (carried from the
previous session and worth keeping): the 5 ft stand-off is sub-cell against an
8 m grid, so it was never closing the channel. That is what sent the search to
`queryLayer` and then to the layer names.

**Verification.** 602 tests, up from 594. The Fahrenheit conversion, the
acronym matching and the depth-layer gate were each confirmed to **fail with
their mechanism disabled**. Drives green at 74 (chart) and 44 (compass). The
Datum and Search tabs have no browser drive, so the °F change rests on unit
tests alone — stated rather than implied.

**Still open.** The chart work has *still* never run in a browser that carried
it. With deploys green again, the next replot is the first real test of the
relay, the failure reporting, the `f=json` fallback and the S-57 names
together.

### 2026-09-13 — claude/navmate-compass-feature-hf4h6z (the deploy had been failing for two sessions)

Reported from the Vercel dashboard: `Build Failed — The 'vercel.json' schema
validation failed with the following message: should NOT have additional
property '//'`.

**One character of good intention, two sessions of work not shipped.** A
`"//": "…"` key was added to `vercel.json` as a comment when the ENC relay went
in (`8b0050d`). JSON has no comments, and Vercel validates that file against a
schema that rejects any property it does not know. It does not warn and it does
not fall back: **the deployment fails outright and the live site stays on the
last good commit.** So production sat on `fb0ece7` while `main` collected the
relay, the chart fixes and the entire compass, all of it looking shipped.
Twelve consecutive deployments failed, every one of them for this.

The repository was green the whole time — typecheck, lint, 593 tests, two
browser drives — because **nothing in the repository was looking at that
file.** That is the actual lesson, and it is more general than the one key: the
checks covered everything except the one artefact that decides whether any of
it reaches a phone.

So `src/lib/vercel-config.test.ts`, which runs in `npm test` rather than on
Vercel's builders: the file parses, carries no comment key anywhere (recursing
into arrays), uses only top-level properties the schema knows, and — the thing
the comment was trying to explain — its SPA catch-all still excludes `/api/`,
asserted by running the rewrite's own regex against `/waypoints` and
`/api/enc`. Asserting the behaviour is strictly better than describing it: the
description is what broke the build. Confirmed by putting the offending key
back, which fails two of the four checks.

The prose that was in the JSON now lives in `DEPLOYMENT.md`, where someone
changing the deployment is already reading, and where it cannot fail anything.

**Verified on the real deployment rather than assumed.** The branch build of
the fix came back READY — the first successful build since `8b0050d` — and
production `4722000` is READY and aliased to `navmate.stationinsight.com`. The
bundle it serves is `index-CVkhMCVU.js`, the same content hash as the local
build, and that bundle contains `WMM2025`, `Take a bearing` and the
figure-of-eight prompt. `lambdaRuntimeStats: {"nodejs":1}` says `api/enc.js` is
deployed as a function, and `/api/enc` answers with something other than the
SPA shell, so the catch-all is not swallowing it in production either.

Note for whoever merges next: `main` had moved while this was in flight —
another session merged `claude/charming-rubin-rlz3ks` again as `ed727cc` (the
hybrid chart/satellite view, labelled boat fields, a failed chart query no
longer passing for empty sea). Both sets of work are on `main` and intact; the
chart drive is 74 checks now, up from 55.

### 2026-09-13 — claude/charming-rubin-rlz3ks (a failed query is not an empty sea)

A screenshot did what four sessions of reasoning had not: it showed the course
card saying **"No charted depths for this area"** with the NOAA chart drawn
correctly underneath it, both ends of the passage in the middle of the Houston
Ship Channel — 500 ft wide, 50 ft deep. That message is a claim about the
water, and it was false.

**`queryLayer` caught every failure and returned zero features.**

    } catch {
      return { features: [], complete: false }
    }

Zero depth areas short-circuits to `coverage: 'none'`, which the screen words
as empty sea. This is the same bug fixed one level up last session — a
swallowed failure passing for a successful empty result — still live one level
down, and worse here, because the earlier one only failed to explain itself
while this one asserts something about the sea that is not true.

**And the reason the queries were failing is almost certainly the format.**
`f=geojson` is not a given: ArcGIS serves it from MapServer only at 10.4+, and
a server that does not support it does **not** fail — it answers HTTP 200 with
an error object in the body. `res.ok` is true, `featuresOf` finds no `features`
array, returns `[]`, and a working depth layer reads as nothing charted. That
fits every symptom at once: layer discovery succeeded (it uses `f=json`), the
WMS chart drew, and only the depth and hazard queries came back empty.

Three changes, each closing one way of being silently wrong:

- `arcgisError` detects an error body at HTTP 200, on the queries **and** on
  layer discovery — where such a body had been reaching `matchLayers`, matching
  nothing, and being reported as `no-layers`, blaming NavMate's own patterns
  for a service fault.
- Queries try `f=geojson`, then fall back to `f=json`. Esri's form is always
  available and needed no new parsing: `ringsOf` and `featuresOf` already read
  `rings` and `attributes`, which had been written for exactly this and never
  had a caller.
- `queryLayer` returns *why* it came back empty. When no depth-bearing layer
  answered, `fetchChartFeatures` throws `unreachable` carrying the service's
  own message. One quadrant that answered still counts as real data, so a
  partial box is not condemned by its neighbours.

**Stated plainly: this is a diagnosis, not a confirmed fix.** The relay is live
and would have settled it, but the sandbox proxy denies
`navmate.stationinsight.com` as flatly as it denies NOAA — tried, not assumed.
If the format is the cause this fixes it; if it is not, the screen now prints
the service's own error instead of asserting an empty sea, which is what
produces the answer on the next plot. `fix_list.md`'s top item stands.

**A third base layer: hybrid.** The chart blended over the imagery at half
strength, so a shoal and the bank it belongs to are one glance. Not a new
mechanism — `SatelliteMap` already drew layers with an opacity, so `base` now
selects a *list* of base sources. The load-bearing part is the zoom clamp: the
imagery publishes 0–19 and the chart 6–18, and the map clamped to whichever
single source was selected, so hybrid at zoom 19 would have drawn imagery alone
— a "50/50 mix" silently becoming 100 % satellite, which on the water reads as
"the shoal is gone" rather than "the layer stopped". `sharedZoomRange` clamps
to the levels every base layer publishes. Three choices no longer fit beside
the Buoys toggle at 320 px, so the base layer took its own row.

**The boat form was placeholders, not labels.** Once filled it was eight bare
numbers with nothing saying which was the draft and which the stand-off — read
back months after being typed. Every field now carries a real `<label>`
(`Field` in `ui.tsx`); the placeholder keeps the suggested default, which is
only useful while the box is empty. *Air draft* became **Height above water**
with a hint naming the tallest point, on the same reasoning: the label has to
be the question, not the jargon.

**Both speeds in the course card.** A table of cruise and flat out, each with
its own time to run and its own arrival clock — "how long if I push it" is the
question one number cannot answer. Fuel stays on the cruise row alone, because
`fuel_burn_gph` is burn *at cruise* and burn climbs steeply with speed;
scaling it by time would under-report the fuel for the faster passage, which is
the one where running out matters.

**One premise of my own, corrected by the user's numbers.** I had suspected a
wide stand-off was closing the channel from both banks. Their boat carries 5 ft
— sub-cell against an 8 m grid — so it blocks nothing, and the hypothesis was
dead. Worth recording because it is what sent the search to `queryLayer`.

**Verification.** 589 tests, up from 581. The three new chart tests were each
confirmed to **fail with their mechanism disabled**. The drive is 74 checks, up
from 57: eight boat labels asserted as real `<label>` elements, hybrid asserted
from the DOM rather than from network hits (the chart tiles are already cached
by the time the base switches, so a request-counting check passed for the wrong
reason and was rewritten), and the two paces compared on their minutes — the
first version of that check compared the row count twice and would have passed
with both speeds showing the same time.

**Merge note.** `main` had moved three commits ahead with the compass work;
merged in cleanly, no conflicts.

### 2026-09-13 — claude/navmate-compass-feature-hf4h6z (the compass, made an instrument)

"Fix the compass feature. Make it rival other compass apps with graphics and
accuracy." Both halves were real, and the accuracy half was worse than it
looked: the old dial had **three** separate faults, any one of which is enough
to put a boat on the wrong heading.

**It was showing magnetic north and telling the crew to fix it themselves.**
The card carried a note — "apply your local declination before passing a
bearing to anyone working from a chart" — directly underneath a table of *true*
bearings worked from coordinates. On this coast that is 10–20° of disagreement
between two numbers on one screen, with the reconciliation left as an exercise.
So `src/lib/geomag.ts` is now the **World Magnetic Model, evaluated on the
device**: geodetic to geocentric, Schmidt semi-normalised Legendre functions to
degree 12, coefficients carried forward from the 2025 epoch by their secular
variation. It runs offline from a compiled-in table, which is the only form
that is any use to a crew out of coverage.

Nothing about that is worth having unless it is *right*, so it is checked
against **all 100 of NOAA's own published WMM2025 test values** — every
declination and inclination to within 0.006°, every intensity to within
0.15 nT, across the model's whole five-year window and a spread of altitudes.
The dial now says `13.9° W` for Boston and corrects the heading by it.

**It could not survive the phone being held up.** `360 - alpha` is exact for a
phone lying flat and meaningless for one held at eye height, because `alpha` is
the azimuth of the **top edge of the screen**, and when that edge points at the
sky every direction is the same direction — so a few degrees of roll swings the
heading by tens. `src/lib/heading.ts` builds the whole rotation matrix and
chooses the pointer from the hold: top edge when flat, back of the phone when
held up, interpolated across a band deliberately placed where the two answers
*agree*. The browser drive puts five physically identical attitudes through it
— the same direction, rolled ±40° — and reads **330, 330, 330, 330, 331**. With
the old code restored, the same five read **291, 309, 329, 350, 9**.

There is one 180° ambiguity left, at top-edge-pointing-straight-down, and there
is no removing it: a phone in that attitude points at every bearing at once.
It is placed where nobody holds a phone, and said so in the file.

**The dial span the long way round north.** `rotate(-heading)` with 359 → 1 is a
358° backspin, once per pass through north, on the one instrument whose whole
job is north. The drawn angle is now unwrapped and allowed to run past 360, and
the drive reads the transform back out to prove it: 362.4° then 358.2°, four
degrees, not three hundred and fifty-six. With the fix removed: -357.6° then
-1.8°.

**Then the thing no phone compass admits to.** A magnetometer beside a radio,
an engine block or a steel wheelhouse is wrong by tens of degrees and gives no
sign except that the numbers will not settle. iOS reports its own accuracy
figure; Android reports nothing at all. So the store watches the scatter — but
"the readings keep changing" is also exactly what a boat coming round looks
like, and telling a coxswain mid-turn that their compass is broken is worse
than silence. `headingWander` fits a straight line through the recent readings
and reports the **residual**: a turn at any rate fits the line, jitter does not.
The first version measured how far the readings moved, and the browser drive
caught it calling a 45°/s turn a fault — a bug that would have fired on every
hard turn of every search.

**Smoothing had the same tension and gets the same treatment.** Enough damping
to hold a needle steady in a shaking hand puts it seconds behind a boat coming
round, and a crew steering by a lagging compass chases it. The time constant
now closes up as the error grows — 0.4 s still, 0.05 s turning — and is scaled
by elapsed time rather than sample count, so a phone reporting at 60 Hz is not
smoothed twice as hard as one reporting at 30. Measured in the drive: **8° of
lag at 45°/s**, which is faster than anything this app will be on, and back
within 2° a second after steadying. That lag is inherent (rate × time constant)
and is recorded rather than hidden.

**The graphics.** A 112 px dial with eight ticks became a full-width rose: 180
graduations at 2°, stepped at 10° and 30°, numbered every 30°, cardinals and
intercardinals, a red north arm stopping short of a hub so it never crosses the
digits, the heading read large in the middle with its reference spelled out
under it, a fixed amber index, a sky-blue pointer and dashed lead line to the
chosen waypoint, a hollow marker for course over ground beside the heading —
the gap between them is the set the boat is taking — and a spirit level whose
bubble says *how* to hold it, not just that it is wrong. It animates in a frame
loop against the group's transform rather than through React, because
re-rendering 180 ticks at 60 Hz costs battery on the one device that has none
to spare, and it honours `prefers-reduced-motion`.

Also new: **Take a bearing**, which holds up to four sighted bearings with times
so the phone can be lowered and the numbers read — two bearings and a chart is
a fix, and it is what a hand-bearing compass is for. The bearings table gained a
per-row arrow pointing the way to turn.

**Verification.** 576 tests, up from 431: 111 in `geomag.test.ts` (100 of them
NOAA's own), 34 in `heading.test.ts` against attitudes worked out by hand — a
test cannot tilt a phone, so the maths is checked where it can be. Plus
`scripts/drive-compass.mjs`, **42 checks** driving the production build with
synthetic `DeviceOrientationEvent`s, which is the only thing that answers
whether any of it reaches the screen. Four of the new behavioural checks were
each confirmed to **fail with their mechanism removed** — the roll invariance,
the unwrapped rotation, the turn-versus-jitter test and the declination
correction. One of them (the lift from flat to eye height at zero roll) passes
against the old code too; that is said plainly in the script rather than
counted as evidence.

**Not verified, and in `fix_list.md`:** none of this has run on a real phone.
Chromium's synthetic events are the real code path but not a real magnetometer,
and three things can only be answered on hardware — whether Android's
`deviceorientationabsolute` is magnetic north as assumed (it is documented so,
and the whole declination correction rests on it), whether iOS's
`webkitCompassAccuracy` maps onto the steadiness bands sensibly, and whether
the wander thresholds are right for a real sensor's noise floor rather than for
a synthetic one.

### 2026-09-13 — claude/charming-rubin-rlz3ks (a straight line through land)

Two reports from the phone, one of which was not a bug and one of which was
three of them.

**"I click the NavMate app and it opens the command RescueGPS instead."** Not
the last change, and not code. The domain handover had completed — verified
through the Vercel API rather than assumed: `navmate.stationinsight.com` is on
`rescuegps-navmate` (production `fb0ece7`, READY) and
`rescuegps.stationinsight.com` is on `rescuegps-navigator-pro`. A PWA install
is bound to the origin it came from, so the icon opened what now lives at the
old address. The remedy was on the phone: delete, reinstall from the new host.

That retired `MovedNotice`. It rendered **only** on the old host, so it could
warn people before the swap and disappear after — and it never got the chance,
because the moment the domain moved, NavMate stopped being served from the one
place the banner could appear. Deleted with its two call sites and the three
drive checks that had to re-serve `dist/` under the old hostname to exercise
it. The lesson is now in `DEPLOYMENT.md` rather than only in a commit: **a
notice inside the app is the wrong instrument for an origin move**, because
the move deletes the only place it can render. Out of band, before the domain
is pulled, is the only thing that works.

**"Auto-plot only does a straight line, and it goes through land."** The router
was not choosing that line. `planRoute` fell back, and the fallback avoids
nothing — it never had a chart. What made it undiagnosable is that three
different failures were indistinguishable:

  - the service could not be reached (no signal, moved endpoint, or the host
    not sending `Access-Control-Allow-Origin`);
  - the service answered but nothing matched `ROLE_PATTERNS` (NOAA
    republishes weekly and renames);
  - the service answered and this water genuinely has no ENC coverage.

All three came out as `coverage: 'none'`, and the first two got there by
swallowing the error entirely. On the water that is the difference between a
bug and geography.

**And a worse one underneath it.** `useChartData.load` treated a swallowed
failure as a *successful* empty load — `status: 'ready'` with `bounds` set —
so `covers()` returned true and every later plot in that area reused the empty
result. One blocked request turned the plotter into a straight-line-only tool
for the rest of the session, with nothing on screen to say so. `bounds` is now
left null on failure, so the next plot retries.

`fetchChartFeatures` throws `ChartUnavailableError` with a `kind`
(`unreachable` | `no-layers`), the band and the **service URL it tried**;
genuine no-coverage still returns `'none'`, because that one is a fact about
the sea rather than a fault. The chart card says which it was and names the
host.

**Then the most likely cause, removed.** The chart *tiles* are `<img>`, so the
browser fetches them however NOAA likes; the depth and hazard **queries** are
`fetch`, which a browser blocks cross-origin unless the host allows it. That
is exactly the reported shape — chart visible, routing dead — and nothing in
the page can work around it, because the block happens before any of our code
runs. So `api/enc.js`: a same-origin relay, and the first server-side code in
this app. Deliberately **not** a general proxy — one host, one path prefix, no
credentials, and three separate checks (scheme, host, path) because each is a
different way of being somewhere else. An open relay would let anyone route
traffic through this deployment.

It doubles as the diagnostic that is still owed: a failure returns NOAA's own
status and body rather than an opaque browser block, so a 404 (wrong service
path) and a 502 (relay reached nothing) are readable instead of identical.

Supporting changes: `encRequestUrl` puts the routing rule in one exported,
tested function — outside a browser the URL is used as-is, so unit tests and
any Node caller are unaffected. `vercel.json`'s SPA catch-all now excludes
`/api/` (Vercel checks the filesystem before rewrites, so belt and braces, but
the kind that fails silently). `vite.config.ts` proxies `/api/enc` in dev with
the same single-host rule, because the function only exists once deployed and
`npm run dev` would otherwise 404 every query and look broken for the wrong
reason.

**Verification.** 431 tests, up from 427. The drive is 55 checks: it now stubs
the **relay** rather than the NOAA host, so it exercises the path the app
actually takes, and asserts 12 queries went through the relay and 0 went
direct. The three new failure-reporting checks were each confirmed to fail
with the old swallowing restored.

**Still unconfirmed, and stated plainly rather than assumed.** The sandbox
proxy denies every NOAA host — checked in the proxy log, not guessed — so
`enc_harbour` and its siblings have **never been resolved against the real
service**. If the service paths are wrong rather than CORS, the relay does not
fix it; it does now say so. The answer comes from a desktop console or from
the chart card once this is live, and is recorded as the top item in
`fix_list.md`.

### 2026-09-13 — claude/charming-rubin-rlz3ks (channels, the From/To header, arrival)

Three requests in one session, each one a correction to how the chart plotter
behaves in a boat rather than a new screen.

**"The start location and destination need to be more compact and above the
chart… once start and destination are selected the course is plotted."** The
map already sat above the Start and Destination cards — but under a 110–450 px
Boat card, and above roughly 900 px of Start and Destination, so a crew
scrolled past the chart to say where they were going and back again to look at
it. Both ends are now two rows in one card above the map: a line of position
and a chip row each (From = Here / Map / Coords, To = Map / Coords / Waypoint /
LKP). Every shortcut survived; they just fit. The start-before-destination gate
is gone — it was re-implemented in six places and bought nothing once the two
were adjacent. The course plots itself on a 400 ms debounce as soon as both
ends and a boat exist; `plot()` gained the `catch` it never had, because
moving it into an effect would have turned a throw into a screen that silently
never showed a course.

**"Both need the 2 options to enter coordinates or choose on map, matching the
app's input method and format selection."** A premise worth correcting before
building: **the app had no format selector anywhere.** `parseCoord` infers the
format from what you type, and the Convert tab shows three at once because it
is a converter, not a picker. So the selector is new. `CoordInput` gives each
format its own boxes and joins them into a canonical string `parseCoord`
already accepts — every rejection the strict parser makes still fires, and
`coords.ts` is untouched except additively (`ddmParts`/`dmsParts`, with
`toDDM`/`toDMS` rebuilt on them so the rounding carry that stops `59' 60.0"`
exists once; its 23 tests pass unchanged, which is the proof). DD keeps a
signed box and no hemisphere buttons, because offering both a minus and a W
invites "-94.8 W", which the parser rightly refuses. Rolled out to the
Waypoints form, the waypoint editor and the LKP card, so "matches the rest of
the app" is true rather than aspirational, and the format is one persisted
setting.

**"Stay within marked channels… not through land, obstructions/piles, or leave
marked channels."** NOAA's dredged areas were already being fetched and
flattened into plain depth polygons one line later; fairways and pilings were
not fetched at all. A dredged area is now recorded **twice** — it carries a
`DRVAL1` like any depth area, and it is also water traffic is meant to be in,
and flattening it lost the fact the coxswain steers by. Fairways become
channels and never depths: a FAIRWY carries no depth and inventing one is the
guess this engine refuses everywhere else, so marked water is *preferable*,
never *passable*. Piles get a 10 m footprint rather than a wreck's 40 m —
piles line the banks of dredged cuts and at the harbour band 40 m is five
cells, so both banks would close a 60 m channel outright and fail the route to
a straight line, which is worse than having no pile data at all.

The cost is a **penalty on non-channel cells, never a discount on channel
ones.** `astar`'s octile heuristic is admissible *and consistent* only while
every step costs at least 1, and the closed-set pruning depends on the second —
a cheaper-than-1 cell would silently return a path that is not the best. Two
levels encode "until there is a clear, deep enough unobstructed path": water a
full depth band clear of the boat is cheap to cross, water that merely clears
its draft is dear. `CHANNEL_WEIGHT`/`preferCells` were renamed to edge wording,
because they mean "stay off the bank" and two meanings of "channel" in one file
made it unreadable.

**"A leg completes within 50–150 ft."** It was 0.05 NM — 304 ft. Now a setting
(50/100/150, default 150). Tightening the circle alone would have caused a
worse failure than the one being fixed: at 20 kn a boat crosses a 50 ft circle
in three seconds, so the fixes can straddle it and the leg never completes at
all. A leg now also completes on passing the mark **while still heading down
the leg** — the condition that preserves this function's own long-standing
refusal of a plane-crossing test ("a boat that has to abort a turn and come
round again should be given the same point back"). The circle is floored at the
fix's own accuracy, because a ±25 m receiver cannot report being inside a 50 ft
circle.

**Three bugs that only a browser found, and they are the argument for the
drive script.**

1. **stringPull's channel budget was argued provably inert with no channel
   charted** — a chord cannot be octile-longer than the path it replaces. True
   in arithmetic, false in floating point: both sides sum the same irrational
   √2 a different number of times in a different order, so equal lengths
   differed by ~1e-13 and a strict `>` rejected half the chords. A plain course
   round one bar came out as **49 legs instead of 3**. Fixed with an arithmetic
   tolerance, pinned by a test that fails without it.
2. **A pure distance ramp made one cell outside a cut cost ~8 % of the
   penalty** — near enough to free that the course hugged the channel boundary
   for its whole length without ever crossing it. The decision a crew makes is
   binary, so most of the weight is now a step at the boundary.
3. **ChartTab's "Steer this route" never started the position watch.** Only the
   search patterns did. With tracking off the fix never changed, so **no leg
   could ever complete** and the card sat on leg 1 for the whole passage. Every
   unit test passed against code that could not advance a single leg in the
   app.

**Verification.** 427 tests, up from 391. The browser drive is 54 checks, up
from 39: the From/To controls are above the chart by bounding box, both ends
set by coordinates and by map tap, the format selector switches and the value
survives, impossible minutes are refused, the course appears with no button
press and swings into the stubbed dredged cut rather than merely clearing the
bar, and the boat is walked to a real turn point and asserted **not** arrived
at 200 ft (which the old 304 ft circle would have called done) and arrived at
120 ft. Every new behavioural test was confirmed to fail with its mechanism
disabled — one was rewritten after that check showed it passed either way.

**Still open, in `fix_list.md`:** the FAIRWY and PILPNT layer names have never
been seen for real (the proxy 403s NOAA); if a name misses, the preference goes
inert and routing behaves as before, which is the safe way to fail and is
itself a test. Piles are high-cardinality and may start tripping the transfer
limit. The preference only sees inside the routing grid. The pass-abeam rule is
unit-tested only — a scripted position cannot produce a believable course
through the Kalman filter, so the first real test is a boat at speed.

### 2026-09-13 — claude/charming-rubin-rlz3ks (incidents merged into the command table)

"Fix the incidents/navmate_incidents issue." Also asked whether the
`grcsrldrkryrfjsildej` Supabase project needed adding to both Vercel
workspaces — **no**, and worth recording why: that ref is a stale default
baked into the command app's `frontend/src/config/config.js` and is not in the
Supabase org at all. Adding it anywhere would point a live app at nothing.

**The fix: one table.** The command dashboard subscribes to `incidents` in
order to "detect new incidents from other users (e.g. field app)" — its own
comment — while NavMate wrote `navmate_incidents`, so that subscription could
never fire. Migration `20260913041316` folds NavMate onto their table.

Done at the only cheap moment: `navmate_incidents` held **0 rows** and no
`sar_records` referenced it, so nothing was migrated and nothing lost. Six
months from now it would have been a data migration with live incidents in it.

**What made it possible** is that NavMate's incident table was built to mirror
theirs deliberately back in August — the 22 `incident_type` codes and 9
`status` values are byte-identical, so not one value needed translating. The
gaps were all additive: `client_id` (NavMate's offline idempotency key, and
the discriminator that keeps command-created incidents out of the field app's
list), `team_id`, and dropping NOT NULL on `lkp_lat`/`lkp_lng` because NavMate
opens an incident before the LKP is known. Their
`update_incident_location` trigger already tolerated nulls — `ST_MakePoint` of
a null returns a null geometry rather than erroring — which was checked before
relying on it, not after.

**Their triggers turned out to do the tie-in for free.**
`generate_incident_number` only fills a blank number, so NavMate's
offline-generated one survives; `tf_incidents_add_creator_participant` adds the
crew member to `incident_participants`; `tf_incidents_set_initial_ic` makes
them the initial IC. Which is the right semantics anyway: the unit first on
scene runs it until command arrives.

**RLS changes are additive only**, so nothing the command system relies on
moved. Two new policies: team members may update a NavMate-scoped incident
(their own policy is IC/creator/commander only, and the unit closing a search
is rarely the one that opened it), and a scoped DELETE (they had none at all,
so nobody could delete anything; command rows have `team_id` null and stay
undeletable).

**Verified against the live database as real users**, not assumed. A throwaway
crew member inserted a NavMate-shaped incident with no LKP: it landed, its
incident number survived their trigger, the participant row appeared with role
`ic`, `current_ic_id` was set, and `lkp_location` came back null without
error. A second throwaway account — a plain team member who did *not* open it —
could read and update it, and was blocked (0 rows) from touching or deleting
the command system's own rows. Test data removed; row counts back to baseline
(4 incidents, 26 asset_tracks, 6 field_events, 4 participants). Advisors
unchanged.

**One app-side detail that matters more than it looks.** The load now names its
columns explicitly instead of `select('*')`. That table has ~50 columns
including `incident_password_hash`, and NavMate's cache is persisted to
localStorage on every crew phone — a star select would have put a password hash
there. The column list sits next to `toRow` in `src/store/useIncidents.ts` so
the two cannot drift.

Still open, and now in `fix_list.md`: a NavMate incident is readable by every
signed-in user, because the command system's `"Org-scoped incidents read
(transitional)"` policy returns true whenever `organization_id` is null, which
is how NavMate creates one. Same shape as the `profiles` finding and the same
answer — their policy, their posture, NavMate does not depend on it. And the
reverse direction (a crew joining an incident command opened) is deliberately
not built: NavMate filters on `client_id is not null`, and their
`join_requests` / `incident_participants` tables are where that would go.

### 2026-09-13 — claude/charming-rubin-rlz3ks (domain split, NavMate standalone)

"Make NavMate.stationinsight.com the url for the app… RescueGPS.stationinsight.com
the url for the command side. NavMate will be the PWA that users download to
their phone… RescueGPS is the command side that communicates with each
individual user and ties everything together."

**This was a swap, not an addition.** `rescuegps.stationinsight.com` was on the
NavMate Vercel project and the command system (`rescuegps-navigator-pro`) had
no custom domain at all — only `.vercel.app`. A domain lives on one Vercel
project at a time, so NavMate has to release the old address before the command
side can take it, and there is a window in between where it is down. The order
is written into `DEPLOYMENT.md` and `fix_list.md`. There is no Vercel MCP tool
for project domains, so those three steps are the user's.

**No app code was needed for the hostname.** Worth recording because it was the
first thing checked and it shaped everything after: `emailRedirectTo` and the
password-reset `redirectTo` are both `window.location.origin`
(`useAuth.ts:79`, `:112`), the manifest's `start_url` and `scope` are `/`,
`vercel.json` has no host conditions, and the service-worker rules pin only
third-party hosts. Not one hostname is hardcoded in `src/`. Everything that
changed was documentation, the product name, and two dashboards.

**Renamed to plain "NavMate"** — title, meta description, manifest `name`,
header, GPX `creator`. The sign-in screen swapped `/logo.png` for
`/emblem-192.png`: that logo has `RESCUE GPS` baked into the raster, and
leaving it above an `<h1>NavMate</h1>` puts two product names on one screen. A
mark carries the family; a wordmark argues with the name. Deliberately **not**
renamed: the export format ids `rescuegps-navmate/datum-report` and
`…/incident-handoff` (a contract the command side reads, asserted in
`sar.test.ts:199` and `incident.test.ts:100`), the handoff toast that genuinely
refers to the command system, and `tides.ts`'s NOAA caller identity.

**The moved-address banner** (`src/components/MovedNotice.tsx`). An installed
PWA belongs to the origin it came from: the copies already on phones stay
pointed at `rescuegps.stationinsight.com`, which will serve the command system,
and their cached waypoints, queued writes and saved chart tiles do not follow.
The banner renders **only** when the app is served from that old host, which
makes it self-retiring — it disappears for each person the moment they
reinstall, and never shows in development, on a preview, or on the new address.
Note the ordering this implies: `main` has to deploy *before* the domain is
pulled, or the notice never reaches the people it is for.

The drive proves it **appears** on the old host, not just that it stays hidden
elsewhere — it serves the same `dist/` under
`https://rescuegps.stationinsight.com` through a Playwright route. A test that
only asserted absence would have passed with the condition inverted.

**Auth is now one config for two apps**, and Site URL is a single value. It
goes to the **command system**, and that is evidence-based rather than a coin
toss: its `auth.signUp` (`frontend/src/services/supabase.js`) passes no
redirect and it has no password-reset path at all, so Site URL is its only
fallback; NavMate always sends its own origin explicitly and is unaffected by
the choice. The redirect allow-list must carry the bare origin *and* `/**` for
both hosts — an un-allow-listed redirect is silently replaced by the Site URL,
so missing the NavMate entries would drop a crew member resetting a password
into the command dashboard.

**Two findings in the command repo**, recorded in `fix_list.md` rather than
acted on (different repo, read via the GitHub API): its
`frontend/src/config/config.js` defaults `SUPABASE_URL` to
`grcsrldrkryrfjsildej`, a ref that is not in the Supabase org — the client that
matters reads `import.meta.env` with no fallback and goes `null` in "demo
mode", so the deployment must be overriding it, which is worth confirming. And
its dashboard subscribes to `incidents` with the comment "detect new incidents
from other users (e.g. field app)", while NavMate writes `navmate_incidents` —
so "ties everything together" is not yet true of incidents. A decision, not a
bug, and now visible.

**Verification.** 391 tests, typecheck, lint, build clean; the drive grew to 39
checks (title, header name, banner present on the old host and absent
everywhere else, plus the existing chart-plotter flow). Built
`dist/manifest.webmanifest` confirmed as `"name":"NavMate"`,
`"short_name":"NavMate"`, `"start_url":"/"`, `"scope":"/"` — still
origin-portable.

### 2026-09-13 — claude/charming-rubin-rlz3ks (re-home to RescueGPS, start point)

Same branch, later session. "The NavMate project was merged into
rescuegps-production… renamed to rescueGPS and contains the NavMate app and the
previously built RescueGPS command software." Plus, mid-session: "before
entering/selecting a destination the app needs to ask the user to select a
starting point — use current location or select on map."

**The rename had happened; the schema merge had not.** Checked before planning:
`ekhvfypxuxskjglwwoqh` was renamed to "RescueGPS" but still held exactly the
command-side 45 tables with the same row counts as the previous session. None
of NavMate's tables were there. So the merge was a thing to *do*, not a thing
to point at, and that was surfaced before any work.

**Re-running the old migrations would have been destructive, quietly.** The
pre-flight is why this is worth recording: `20260803040156` opens with
`drop table if exists public.waypoints cascade`, then hard-fails on
`create table public.profiles` — but the dangerous line is
`create or replace function public.handle_new_user()`. That name is taken here
by the command system's signup trigger (verified: an `on_auth_user_created`
trigger on `auth.users` calls it, and its body fills `role`). `create or
replace` does not error. It would have silently replaced their
profile-creation logic with NavMate's, on a live database. `touch_updated_at`,
`is_team_member`, `is_team_admin` and `is_platform_admin` are the same shape of
hazard.

**So: one new set of migrations, and a `navmate_` prefix on every internal
helper** (`supabase/migrations/README.md` explains the two eras; the old files
stay as history and are marked never-replay). Three `navmate_rehome_*`
migrations plus `navmate_vessels`, applied and verified. Decisions inside them:

- **`profiles` is reused and never altered** — no table, no trigger, no policy.
  NavMate's `callsign` is this database's `call_sign`; the app was changed to
  match rather than a duplicate column added. Their trigger already fills
  full_name from signup metadata, which is what NavMate sends; the callsign is
  carried across by `loadProfile` the first time it sees the row, and
  `updateProfile` became an upsert because NavMate no longer owns the trigger
  that guarantees a row exists.
- **`navmate_incidents`**, not `incidents`. Theirs is 50 columns with live rows,
  scoped by organisation and participant; NavMate's is the small offline-first
  container scoped by team, with the `client_id` key offline sync needs.
  Merging them is a decision about access models, not a rename.
  `sar_records.incident_id` kept its column name, so no SAR client code moved.
- **Teammate names come from `navmate_team_profiles()`**, a SECURITY DEFINER
  function returning id/full_name/call_sign, rather than a NavMate read policy
  on `profiles`. RLS is row-level: a policy would also have handed crews the
  command system's push tokens, emergency contacts and clearance levels. This
  also dropped the app's dependence on an exact FK constraint name that the old
  PostgREST embed needed.

**Verified in-database, which is new.** The browser sandbox still cannot reach
`*.supabase.co`, but the Supabase connection is server-side, so the access
checks were run for real with three throwaway accounts and then cleaned up: a
team member sees the team's waypoints and not a teammate's private one; a
signed-in outsider sees nothing (0 rows on every table, and the roster function
returns nothing for a non-member); `anon` reads 0 from all ten NavMate tables;
a plain member cannot change the team vessel's draft (0 rows), delete the
owner's private waypoint (0 rows), grant themselves platform admin (42501) or
forge a row owned by someone else (42501), while updating the shared incident
is allowed, as designed. Row counts before and after confirm the command side
untouched: `incidents` 4, `asset_tracks` 26, `field_events` 6, their
`handle_new_user` unchanged. Advisors show **no NavMate function callable by
`anon`** — the only ones flagged are PostGIS's.

Note for the next reader: RLS filters rows on UPDATE/DELETE rather than
raising, so "no exception" proves nothing. The checks above count rows actually
changed. The first version of them reported four false passes.

**One finding that is not NavMate's to fix**, now at the top of `fix_list.md`:
the command system's policy `"Authenticated users can view all profiles"` means
every signed-in user on this project can read every `profiles` row, including
push tokens and emergency contacts — and adding NavMate crew accounts widens
who that is. NavMate does not rely on that policy, so it can be tightened
without breaking anything here.

**Accounts:** both `cochranlawncare@gmail.com` and
`jason.cochran@universalhazard.com` already existed on this project with
working logins, so nothing was created and no password was touched — the admin
seed picked up the latter by email on its own.

**Start point selection** (`src/tabs/ChartTab.tsx`). The plotter silently used
the GPS fix as the origin. Now a Start card comes first with **Use current
location** and **Select on map**, the whole Destination card is inert until one
is chosen, and the map's pick state is `'start' | 'dest' | null` so a tap knows
which end it is filling. `plot()` routes from the chosen start; **steering still
follows the live fix**, and when the two differ the route card says so rather
than pretending leg 1 begins under the boat.

**Verification.** 391 tests, typecheck, lint, build clean, and the committed
headless drive extended to 34 checks: the destination really is unavailable
until a start exists, both start controls work, and the rest of the flow
(tap-to-pick, a course round the stubbed bar at 2.94 NM against 2.40 NM direct,
legs, ETA, steering, save-as-waypoints, a dead ENC service degrading to a
warned straight line, no sideways scroll at 320/360/390) still passes.

**Still open:** the Supabase Auth Site URL on the new project has no API and
must be set by hand, or password-reset emails point at the wrong host. And the
live NOAA endpoints remain unexercised, as they have been since the tides were
written.

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
