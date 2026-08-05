# RescueGPS NavMate

Coordinate conversion, live GPS tracking, ETA and shared waypoints for search
and rescue teams. Runs at **https://rescuegps.stationinsight.com**.

This is a standalone app. It shares a subdomain with stationinsight.com and
nothing else — separate codebase, separate hosting project, separate database.

## Features

- **Home** — the screen the app opens on: current position in DDM, DMS and DD,
  the daylight countdown and the waypoints nearest you.
- **Stamp my position** — fixed to the bottom of every screen, so it is under
  the thumb however far the page has scrolled. One press writes the fix, then a
  sheet opens for a name, notes and a photograph from the camera or the
  library.
- **Daylight tracker** — a running countdown to the next dawn, sunrise, sunset
  or dusk, with all four times and the length of the day. Computed on the
  device, so it works with no signal; dawn and dusk are civil twilight.
- **Tides** — high and low water from the nearest NOAA CO-OPS station, with the
  distance and bearing to that station, whether the tide is making or ebbing, a
  picker for the next four stations along, and the full table for the next two
  days. US waters only.
- **Compass** — a rose that turns under a fixed lubber line, from the device
  magnetometer, falling back to GPS course when you are moving. Points to any
  saved waypoint and says which way to turn, with the true bearing and distance
  to everything saved listed underneath.
- **Convert** — type coordinates as decimal degrees, DMS or degrees-decimal-minutes
  and the other formats follow. UTM (WGS-84) is derived alongside.
- **Track** — live position, speed in knots, heading with compass point,
  accuracy and altitude, with the recorded path drawn north-up to fit and
  saved waypoints marked.
- **ETA to waypoint** — distance, bearing and time to a saved waypoint, in
  NM / mi / km, using GPS speed or a manual override. Underneath it, the
  **60 D Street** working — `60 × D = S × T`, distance in nautical miles,
  speed in knots, time in minutes. Fill in any two and the third is worked
  out, with the arithmetic printed so it can be checked against a card. That
  covers the two questions an ETA alone cannot answer: how far can we get in
  the time we have left, and how fast do we need to go to be there.
- **Track recording** — a breadcrumb every 10, 15, 20 or 30 seconds, your
  choice, with distance travelled and elapsed time, exportable as a GPX track.
  The live readout still follows every fix.
- **Waypoints** — name, coordinates, notes and photos, all editable after the
  fact, including attaching photographs to a waypoint stamped earlier. Private
  to your account by default, or shared with a team.
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
  lib/          coordinate math, distance/bearing, 60 D = S × T, sun events,
                NOAA tides, import/export, Supabase client
  store/        Zustand stores: auth, waypoints (with offline queue), teams,
                tracker, tides, heading
  components/   shared UI, header, section menu, bottom sheet, auth screen,
                daylight, tides, compass, track plot, stamp
  tabs/         Home, Track, ETA, Tides, Compass, Convert, Waypoints, Team,
                Data
supabase/
  migrations/   schema, RLS policies, storage rules
brand/
  icon-master.png the RescueGPS emblem, source of every app icon
scripts/
  make-icons.mjs  regenerates the PWA icons from brand/icon-master.png
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
The first path segment is always the *uploader*, which is what the storage
policy allows; a photo added to a teammate's shared waypoint is still readable
by the team because the read policy matches on the waypoint id in the second
segment.

### External data

Tide predictions come from NOAA CO-OPS and need no key. The station list
(`mdapi/prod/webapi/stations.json?type=tidepredictions`) is downloaded once,
slimmed and cached in `localStorage`, so nearest-station lookups keep working
offline; high/low predictions are requested per station in GMT and converted
for display. Coverage is US waters only. Everything else in the app —
including sunrise, sunset and twilight — is computed on the device.

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
