# RescueGPS NavMate

Coordinate conversion, live GPS tracking, ETA and shared waypoints for search
and rescue teams. Runs at **https://rescuegps.stationinsight.com**.

This is a standalone app. It shares a subdomain with stationinsight.com and
nothing else — separate codebase, separate hosting project, separate database.

## Features

- **Convert** — type coordinates as decimal degrees, DMS or degrees-decimal-minutes
  and the other formats follow. UTM (WGS-84) is derived alongside.
- **Track** — live position, speed in knots, heading with compass point,
  accuracy and altitude.
- **ETA** — distance, bearing and time to a saved waypoint, in NM / mi / km,
  using GPS speed or a manual override.
- **Track recording** — every fix taken while tracking is kept as a breadcrumb,
  with distance travelled and elapsed time, exportable as a GPX track.
- **Waypoints** — name, coordinates, notes and photos, all editable after the
  fact. Private to your account by default, or shared with a team.
- **Teams** — create a team, share the 6-character join code, and everyone on
  it sees the same waypoints. Owner / admin / member roles.
- **Data** — export JSON, GPX or CSV for the current scope or the whole
  account; import JSON, GPX or CSV; email a plain-text list.
- **Offline** — installable as a PWA. The app shell and your waypoints are
  cached, and edits made without signal are queued and synced on reconnect.

## Stack

| | |
|---|---|
| Build | Vite 7 + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| State | Zustand |
| Backend | Supabase (Postgres + Auth + Storage) |
| Hosting | Vercel |
| Tests | Vitest |

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Then open the URL Vite prints. Geolocation works on `localhost` without HTTPS;
anywhere else it needs a real `https://` origin.

```bash
npm test        # unit tests
npm run build   # type-check and production build
npm run lint
```

## Project layout

```
src/
  lib/          coordinate math, distance/bearing, import/export, Supabase client
  store/        Zustand stores: auth, waypoints (with offline queue), teams, tracker
  components/   shared UI, header, tab bar, auth screen
  tabs/         Convert, Track, Waypoints, Team, Data
supabase/
  migrations/   schema, RLS policies, storage rules
scripts/
  make-icons.mjs  regenerates the PWA icons from public/icon.svg
```

## Data model

| table | purpose |
|---|---|
| `profiles` | display name and callsign, created automatically on signup |
| `teams` | name plus a unique 6-character join code |
| `team_members` | roster with `owner` / `admin` / `member` roles |
| `waypoints` | `team_id` null means private; otherwise visible to that team |

Photos are stored in the private `waypoint-photos` bucket under
`{user_id}/{waypoint_id}/{file}` and served through short-lived signed URLs.

### Security

Row level security is on for every table, and `anon` has no policy anywhere —
an unauthenticated visitor holding the publishable key can read nothing. The
policies were verified against a live database with three test accounts
covering read isolation, write refusal, cascade behaviour and role escalation.
See `DEPLOYMENT.md` for the full list of what was checked.

The Supabase URL and publishable key are in the client bundle by design. That
is what publishable keys are for; RLS is the boundary. Never put the
service-role key in this repo.

## Deployment

See [`DEPLOYMENT.md`](./DEPLOYMENT.md).
