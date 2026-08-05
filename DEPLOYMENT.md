# Deploying RescueGPS NavMate

Target: **https://rescuegps.stationinsight.com**

## What is already done

- Code is on GitHub: `jcochran6810/RescueGPS_NavMate_App`, release branch
  `main`.
- The Vercel project **exists**: `rescuegps-navmate`, imported from the repo,
  production branch set to `main`. Pushes to `main` deploy automatically.
- Supabase project `puzwcsrtqtbutypzozvu` has the full schema, RLS policies and
  the `waypoint-photos` storage bucket applied. The database is empty and ready.
- `vercel.json` pins the framework, build command, output directory, SPA
  rewrite and security headers, so Vercel needs no build configuration.
- The Supabase URL and publishable key are compiled into the bundle
  (`src/lib/supabase.ts`), so **no environment variables are required**.

## What you need to do

These four steps need a logged-in Vercel/Supabase session, so they can't be
automated from here.

### 1. Create the Vercel project — DONE

Kept for reference, and because the repo's GitHub **default branch** is still
`claude/rescuegps-subdomain-setup-gchtnn`. A fresh import would inherit that as
the production branch again, which is exactly what happened the first time.
Point the default branch at `main` (GitHub → Settings → Branches) to stop that
recurring.

1. <https://vercel.com/new> → **Import Git Repository**
2. Pick `jcochran6810/RescueGPS_NavMate_App`
3. Name it `rescuegps-navmate`
4. Leave every build setting alone — `vercel.json` supplies them
5. **Deploy**

Importing from Git (rather than uploading files) means every push to the
production branch redeploys automatically.

> **Production branch lives under Settings → Environments → Production**, not
> Settings → Git. Vercel moved it. The Git page now only holds the repo
> connection, commit comments, LFS and deploy hooks.
>
> The project's `…-git-<branch>-…` alias domain belongs to the *deployment* it
> was created for, not to the branch setting, so it is not a way to check which
> branch production tracks. Read the Environments page instead.

Project creation cannot be automated from a Claude Code session: the connected
Vercel token can read projects but not create them (`403 "You don't have
permission to create a project."`).

### 2. Attach the subdomain

`stationinsight.com` is already in this Vercel team — it is attached to the
**`bunker-gear`** project, which serves the Station Insight site.

A subdomain can live on a different project than the apex domain, which is
exactly what you want here: NavMate gets its own project, its own build and its
own database, and only shares the parent domain name.

1. Open the new **rescuegps-navmate** project → **Settings → Domains**
2. Add `rescuegps.stationinsight.com`
3. Because the domain is already in this team, Vercel configures DNS itself and
   issues the certificate — usually under a minute, no records to copy.

Do **not** add it to the `bunker-gear` project. Keeping it on its own project is
what keeps the two apps isolated.

If Vercel does show a DNS record to add instead (which happens when the domain
uses external nameservers rather than Vercel's), add exactly the record it
displays at whatever manages `stationinsight.com`'s DNS — typically
`CNAME rescuegps → cname.vercel-dns.com`.

### 3. Point Supabase Auth at the subdomain

Sign-up confirmation and password-reset emails link back to whatever is
configured here, so this must be set or those links will land on the wrong host.

**Supabase → Authentication → URL Configuration**

| Setting | Value |
|---|---|
| Site URL | `https://rescuegps.stationinsight.com` |
| Redirect URLs | `https://rescuegps.stationinsight.com`, `https://rescuegps.stationinsight.com/**`, `https://rescuegps-navmate.vercel.app/**` |

List the **bare origin as well as** the `/**` glob. The app passes
`window.location.origin` as its redirect (`src/store/useAuth.ts`), which has no
trailing slash, so a `/**` pattern alone may not match it. Supabase implicitly
allows the Site URL, so it would probably work anyway — but the failure mode is
horrible to diagnose, because the email sends fine and only the click is
rejected.

The `vercel.app` entry lets you test signup before DNS is attached; remove it
once the subdomain is live if you would rather not leave that host working.

There is no MCP tool for any of this — it is the dashboard, or
`PATCH /v1/projects/{ref}/config/auth` on the Management API with a personal
access token.

Also decide, under **Authentication → Sign In / Providers → Email**, whether
**Confirm email** stays on:

- **On** (default) — new users must click a link before they can sign in. Safer,
  but needs working email delivery.
- **Off** — signup logs the user straight in. Faster for a small trusted crew.

Supabase's built-in email sender is rate-limited and not meant for production.
If you keep confirmation on and expect real signups, set up custom SMTP under
**Project Settings → Authentication → SMTP Settings**.

### 4. Rename the Supabase project

It is still called `plan-review-repeat`. The management API cannot rename a
project, so: **Supabase → Project Settings → General → Project name** →
`RescueGPS NavMate` → Save. Cosmetic, but it will confuse you in six months.

## Verifying it works

Once the domain resolves, on a phone:

1. Open `https://rescuegps.stationinsight.com` — the sign-in screen should load.
2. Create an account.
3. **Track → Start tracking** — the browser must prompt for location. That
   prompt appearing confirms HTTPS and geolocation are both working. (No prompt
   means the page was served over HTTP.)
4. **Convert** — type `27.98785` / `-82.44712`; DMS, DDM and UTM `17R …` fill in.
5. **Waypoints** — save one, then reload. It should still be there.
6. **Team** — create a team, and confirm the join code appears.
7. Use the browser's "Add to Home Screen" to install it as an app.

## Isolation from Station Insight

| | Station Insight | NavMate |
|---|---|---|
| Vercel project | `bunker-gear` | `rescuegps-navmate` |
| Domain | `stationinsight.com`, `www.` | `rescuegps.stationinsight.com` |
| Repo | separate | `RescueGPS_NavMate_App` |
| Database | separate | Supabase `puzwcsrtqtbutypzozvu` |

Nothing is shared except the registered domain name. Deploys, builds, env vars,
auth users and data are all independent. The `rescuegps-production` Supabase
project (`ekhvfypxuxskjglwwoqh`, the full SAR platform) was not touched.

## Security verification

The access rules were tested against the live database with three throwaway
accounts — an owner, a team member and an outsider — plus the `anon` role that
an unauthenticated visitor holding the publishable key would have. All test
data was deleted afterwards; the database is empty.

**Read isolation**

- A sees only its own waypoints; a private waypoint is invisible to a teammate
- A teammate sees shared waypoints and the roster, and teammate profiles
- An outsider sees no waypoints, teams, rosters or profiles
- `anon` reads nothing from any table

**Writes that must be refused**

- Creating a waypoint owned by another user
- A member deleting, editing or renaming a teammate's waypoint
- A member renaming the team, promoting itself, adding people, or rotating the
  join code
- An outsider posting into a team or deleting a private waypoint
- `anon` inserting anything, or calling `create_team` / `join_team` /
  `rotate_join_code`
- An invalid join code

**Integrity**

- A member can add waypoints to their own team, and can leave a team
- The last owner cannot abandon or demote themselves out of a live team
- Deleting a team cascades its roster; deleting an account cascades its
  profile, memberships and waypoints
- Both triggers still fire after `EXECUTE` was revoked from every role

Supabase's security advisor is clean apart from expected notices about the
`SECURITY DEFINER` RPCs, which are intentional and documented in
`supabase/migrations/20260803041938_navmate_revoke_trigger_functions.sql`.

## Known gaps

- **Not yet exercised against a browser.** The sandbox this was built in blocks
  outbound traffic to `*.supabase.co`, so signup, sync and photo upload were
  verified at the database and unit-test level but not clicked through end to
  end. Step 4 of "Verifying it works" above is the first real run.
- **Offline photo capture.** Waypoints saved offline sync when signal returns,
  but photos need a connection at the moment of saving; the app says so when it
  happens.
- **No map.** Deliberately out of scope for this pass. It is the obvious next
  addition, and the offline tile story is the reason it wasn't rushed.
