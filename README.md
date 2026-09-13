# NavMate

Coordinate conversion, live GPS tracking, ETA and shared waypoints for search
and rescue teams. Runs at **https://navmate.stationinsight.com**.

**NavMate is the field app.** It is what a crew carries: it collects position,
waypoints, notes and photographs where the work happens, holds them when there
is no signal, and sends them on to **RescueGPS**, the system that does the
heavier work with them. Everything here is built around that job — capture
first, sync second, and never lose a fix waiting for a network.

The two run at separate addresses and are separate codebases:

| | |
|---|---|
| **NavMate** — the field PWA crews install on a phone | `navmate.stationinsight.com` (this repo) |
| **RescueGPS** — the command system that ties an incident together | `rescuegps.stationinsight.com` (`rescuegps-navigator-pro`) |

They share one Supabase database (`ekhvfypxuxskjglwwoqh`), which is the seam
between them — see `supabase/migrations/README.md`.

> **Moving from the old address.** NavMate used to live at
> `rescuegps.stationinsight.com`, which now serves the command system. A PWA
> install is bound to the address it came from, so a copy installed from the
> old one keeps its own cached waypoints, queued writes and saved chart tiles
> and none of it follows. Uninstall it and install again from
> `navmate.stationinsight.com`; anything stamped there and not yet synced does
> not make the trip. The app shows a banner saying so, but only when it is
> being served from the old address, so it retires itself.

This is a standalone app with its own codebase and hosting project. Since
September 2026 it **shares a Supabase database with the RescueGPS command
system** (project `ekhvfypxuxskjglwwoqh`), which is what makes the eventual
field-to-command tie-in a query rather than an export. See
`supabase/migrations/README.md` for what that sharing costs and how it is kept
safe — the short version is that `profiles` belongs to both applications, and
NavMate's internal database functions are prefixed `navmate_` so the two
cannot overwrite each other.

## Features

- **Home** — the screen the app opens on: current position in DDM, DMS and DD,
  the daylight countdown and the waypoints nearest you.
- **Search datum** — the reason this app exists as a standalone tool: a single
  unit searching for a victim logs the last known position (with time, source
  and search-object type), on-scene wind and current, drift markers (deploy,
  retrieve, and the measured set and drift), and clues found. A worksheet
  keeps the datum current — LKP carried by current and leeway for the time
  adrift, with left/right divergence positions and a first search radius from
  the IAMSAR error method. The datum saves as a waypoint so ETA, Compass and
  Track can steer to it, and the whole picture exports as a JSON report in
  RescueGPS's own field names, ready for its drift engine. All of it works
  offline and syncs later.
- **Chart plotter** — a nautical chart with charted depths, and an automatic
  course to anywhere you point at. Set where you are coming from and where you
  are going on one compact row above the chart — your current position, a tap
  on the chart, typed coordinates, a saved waypoint, or the active incident's
  LKP — and the course draws itself on the chart as soon as both ends are
  set. No button. The route keeps the boat in water it can actually use: round
  the shoals, off the wrecks and the piles, and **inside the marked channel**.
  Dredged areas and fairways are read from the chart and strongly preferred, so
  the course rides the cut rather than cutting a corner across open water that
  merely happens to be deep enough; where it does have to run outside marked
  water it says so, on the route and on the leg. It needs to know the boat first — draft, the
  water you want under the keel, how far off a hazard you want to be, and
  cruise speed — which is what the **vessel list** is for; boats are shared
  with the team, so a department's Marine 2 is set up once. The route comes
  back as legs with a course, a distance and the least charted depth on each
  one, plus total distance, time to run, arrival clock time and fuel, and it
  steers leg by leg like a search pattern, auto-advancing at each turn point.
  Turn points save as waypoints. Charts are NOAA ENC (US waters), with
  OpenSeaMap buoys and lights over the top, and the whole area can be pulled
  onto the device before the signal goes.

  Two things it deliberately will not do. It **never routes through water it
  has not seen charted** — unsurveyed is not the same as deep, and where there
  is no chart it says so and gives you a straight line it tells you not to
  trust. And it **plans at chart datum**, never on the tide: the predicted tide
  is shown beside the route because it matters, but a shortcut that needs the
  tide to be in is a grounding waiting for a delay. NOAA publishes this data
  for display and GIS, not as a certified navigation product, and every plotted
  route says so on screen.
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
- **Entering a position, anywhere in the app** — waypoints, the LKP, and both
  ends of a plotted course all use the same control, with a **DD / DDM / DMS**
  selector that lays out the right boxes for the format and remembers your
  choice everywhere. It shows the position back to you in the other two
  formats before you commit it, and it refuses what it cannot read — 75
  minutes, a hemisphere from the wrong axis, a minus sign contradicting a W —
  the moment you type it, rather than guessing at a position that looks
  plausible and is wrong.
- **Live tracking** — position on a satellite map, with speed in knots,
  heading, accuracy and altitude. The fix stream is gated and filtered before
  anything is drawn on it: a fix reporting worse accuracy than you asked for
  is refused, so is one that jumps further than the crew could have moved, and
  what survives goes through a Kalman filter weighted by the receiver's own
  accuracy figure. Speed and course are derived from that filter on the many
  phones that report neither. Refusals are counted and explained on screen
  rather than hidden. The map pans, pinches and follows you, draws the track,
  your waypoints, an accuracy circle and a true scale bar, and can pull the
  imagery around you onto the device before you lose signal. Imagery is Esri
  World Imagery — no key, attributed on the map. `Plot only` fetches nothing
  at all and draws the track north-up to fit, the view that cannot fail on a
  dead link.
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
- **Platform admin** — a dashboard (visible only to the platform admin)
  tracking users, activity, teams, waypoints, datum records, photo storage
  and app errors; a support-request queue users file into from the Team page
  (help, account changes, team problems, bugs) with admin notes back; and
  user profile management. Every admin change is written to an append-only
  audit log. Ported from the MyTradeCrate admin-dashboard pattern to a
  serverless SPA: admin reads are RLS-granted to the admin's own JWT, and
  every mutation is an audited SECURITY DEFINER RPC — no service-role key
  exists anywhere in this app.

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
                NOAA tides, GPS gating and Kalman filter, Web Mercator tiles
                and chart sources, ENC depth/hazard fetching, the route
                planner (rasterise → A* → string-pull), vessel and safe-depth
                maths, import/export, Supabase client
  store/        Zustand stores: auth, waypoints (with offline queue), teams,
                vessels, chart data, tracker, tides, heading
  components/   shared UI, header, section menu, bottom sheet, auth screen,
                daylight, tides, compass, satellite map, track plot, stamp
  tabs/         Home, Track, Chart plotter, ETA, Tides, Compass, Convert,
                Waypoints, Team, Data
supabase/
  migrations/   schema, RLS policies, storage rules
brand/
  emblem.png      the RescueGPS cross, navy field knocked out
  logo.png        the whole logo including the wordmark
scripts/
  make-icons.mjs   regenerates every icon in public/ from the two masters
  drive-chart.mjs  headless drive of the chart plotter against a stubbed NOAA
```

## Data model

| table | purpose |
|---|---|
| `profiles` | display name and callsign, created automatically on signup |
| `teams` | name plus a unique 6-character join code |
| `team_members` | roster with `owner` / `admin` / `member` roles |
| `waypoints` | `team_id` null means private; otherwise visible to that team |
| `sar_records` | LKP, clues, drift markers and conditions — the datum data. Carries `client_id` (RescueGPS's offline-sync idempotency contract) and `recorded_at` separate from `created_at`, so each kind projects onto the matching RescueGPS table (`lkp_history`, `field_events`, `field_drift_data`, `weather_snapshots`) when the databases merge |
| `vessels` | the boats a team runs — draft, air draft, speeds, fuel burn, under-keel margin and hazard stand-off. Metric, because charted depths are; feet are a display conversion. Read by any team member, written by team admins: a draft is a safety figure |
| `incidents` | shared with the command system. NavMate writes the same table its dashboard watches, so opening an incident in the field appears there live and the crew member becomes a participant and initial IC automatically. `client_id` marks NavMate-created rows, `team_id` carries NavMate's team scope; both are null on command-created incidents |
| `platform_admins` | who may use the admin dashboard; seeded by email |
| `support_requests` | user → platform-admin requests, with status and admin notes |
| `admin_actions` | append-only audit of every admin mutation |
| `app_errors` | runtime errors reported by clients, counted in admin metrics |

Photos are stored in the private `waypoint-photos` bucket under
`{user_id}/{waypoint_id}/{file}` and served through short-lived signed URLs.
The first path segment is always the *uploader*, which is what the storage
policy allows; a photo added to a teammate's shared waypoint is still readable
by the team because the read policy matches on the waypoint id in the second
segment.

### External data

Satellite imagery comes from Esri World Imagery
(`server.arcgisonline.com/.../World_Imagery/MapServer/tile/{z}/{y}/{x}` — note
row before column), with place names from Esri's World Boundaries and Places as
an optional overlay. Neither needs a key, which is what makes them usable in a
static bundle with no server to hide a token behind; both are attributed under
the map. Tiles are cached by the service worker for 90 days, cache-first — a
photograph of the ground does not go stale on the timescale of an incident, and
the crew who needs it most has no link left to revalidate it. **Save imagery for
offline** fetches the tiles around you at the current zoom and one closer, which
is what puts them in that cache before the signal goes.

Nautical charts come from the **NOAA Chart Display Service**
(`gis.charttools.noaa.gov/.../MaritimeChartService/WMSServer`), which renders
NOAA ENC with paper-chart symbology. It is a WMS rather than an XYZ tile
service, so each tile is requested as a `GetMap` over that tile's EPSG:3857
bounding box — in metres, not degrees (`tileBbox3857` in `src/lib/tiles.ts`,
which has its own test for exactly that reason). The older
`tileservice.charts.noaa.gov` raster service has been shut down and is not
used. Buoys and lights come from OpenSeaMap as an optional transparent
overlay.

The depths and hazards the route planner runs on come from **NOAA ENC Direct
to GIS** (`encdirect.noaa.gov`), queried by bounding box per usage band —
harbour, approach, coastal, general, overview, chosen by how long the passage
is. Layer ids are **discovered at runtime** from the service's own layer list
and matched by name, never hardcoded: NOAA republishes weekly and renumbers,
and a hardcoded id that silently came back as something else would route a boat
through a shoal. A query that hits its transfer limit is split into quadrants
and retried, and if it still overflows the area is reported as `partial`, which
the route turns into a warning rather than swallowing. Coverage is US waters,
the same limit the tides have. None of these services needs a key.

Chart tiles and ENC queries are cached by the service worker for 30 days in
their own cache (`navmate-charts`), separate from the imagery's 90 — ENC is
republished weekly, and a month-old wreck position is the wrong kind of stale
to steer by.

Tide predictions come from NOAA CO-OPS and need no key. The station list
(`mdapi/prod/webapi/stations.json?type=tidepredictions`) is downloaded once,
slimmed and cached in `localStorage`, so nearest-station lookups keep working
offline; high/low predictions are requested per station in GMT and converted
for display. Coverage is US waters only. Everything else in the app —
including sunrise, sunset and twilight — is computed on the device.

### Security

Row level security is on for every table, and `anon` has no policy anywhere —
an unauthenticated visitor holding the publishable key can read nothing. That
was re-verified against the shared database on 2026-09-13 with three throwaway
accounts: a team member sees the team's waypoints but not a teammate's private
ones, a signed-in outsider sees nothing at all, `anon` reads zero rows from
every NavMate table, and a plain member cannot change the team's vessel draft,
grant themselves platform admin, or forge a row owned by someone else.

`profiles` is the one table NavMate does not own. It is shared with the command
system, so NavMate reuses it and never alters it: `callsign` is that table's
`call_sign`, and teammate names come from `navmate_team_profiles()` — a
function returning id, name and callsign — rather than a read policy, because
RLS is row-level and a policy would also hand over the command system's push
tokens and emergency contacts. The
policies were verified against a live database with three test accounts
covering read isolation, write refusal, cascade behaviour and role escalation.
See `DEPLOYMENT.md` for the full list of what was checked.

The Supabase URL and publishable key are in the client bundle by design. That
is what publishable keys are for; RLS is the boundary. Never put the
service-role key in this repo.

## Deployment

See [`DEPLOYMENT.md`](./DEPLOYMENT.md).
