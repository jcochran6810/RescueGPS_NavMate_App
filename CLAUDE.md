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
   - **Skipped (BLOCKER emitted)** when: on `main` itself, dirty
     working tree, detached HEAD, `origin/main` does not exist, or
     `git fetch` fails. In each case the assistant must stop and
     resolve before any other work.
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
   If behind > 0, ahead > 0, or dirty: stop and surface to the user. Only
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
scripts/          make-icons.mjs — regenerates PWA icons from public/icon.svg
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
- **Icons are generated, not hand-drawn.** Edit `public/icon.svg`; the PNGs
  are rebuilt deterministically by `scripts/make-icons.mjs` on every build.

## Session log

<!-- newest first; append a new dated entry on every "end session" -->

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
- Bootstrapped `main` from this branch — the repo had no `main`, which would
  have made the protocol emit a blocker on every session.

**Known gaps**
- The signed-in flow has never run in a real browser; this sandbox blocks
  outbound traffic to `*.supabase.co`. Verified at the database and unit-test
  level only.
- No map. Deliberately out of scope for this pass.
