/**
 * Headless drive of the production build: adding a waypoint from every screen
 * that lists them.
 *
 * None of this work is unit-testable — it is a control placed in six render
 * trees and a sheet that writes to a store. What can go wrong is exactly what
 * a unit test cannot see: a button that renders but whose sheet never opens, a
 * coordinate that lands in the boxes but never in the row, a waypoint saved
 * into a scope the list beneath it filters out, a sheet opened from inside
 * another sheet that traps the crew. So the whole thing is driven.
 *
 *   npm run build && node scripts/drive-waypoint-add.mjs
 */
const { chromium } = await import('playwright').catch(
  () => import('/opt/node22/lib/node_modules/playwright/index.mjs'),
)
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

const DIST = '/home/user/RescueGPS_NavMate_App/dist'
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
  '.webmanifest':'application/manifest+json' }

const server = createServer(async (req, res) => {
  let p = join(DIST, decodeURIComponent(req.url.split('?')[0]))
  try { if ((await stat(p)).isDirectory()) p = join(p, 'index.html') }
  catch { p = join(DIST, 'index.html') }
  try {
    const body = await readFile(p)
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404); res.end('no') }
})
await new Promise((r) => server.listen(0, r))
const BASE = `http://127.0.0.1:${server.address().port}`

const checks = []
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const HERE = { lat: 29.3, lon: -94.82 }

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'block',
  permissions: ['geolocation'],
  geolocation: { latitude: HERE.lat, longitude: HERE.lon, accuracy: 5 },
})

/** Every tile host stubbed — the map only has to be tappable, not pretty. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64')
for (const host of ['server.arcgisonline.com', 'gis.charttools.noaa.gov', 'tiles.openseamap.org']) {
  await context.route(`**://${host}/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
}

/** Rows the stubbed backend has been told about, so a save can be read back. */
const written = []
await context.route('**://*.supabase.co/**', async (r) => {
  const url = r.request().url()
  const method = r.request().method()
  const json = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (url.includes('/auth/v1/')) return json({})
  if (/\/rest\/v1\/waypoints/.test(url)) {
    if (method === 'POST' || method === 'PATCH') {
      try {
        const body = JSON.parse(r.request().postData() || '[]')
        for (const row of Array.isArray(body) ? body : [body]) written.push(row)
      } catch { /* the assertion below will notice */ }
      return json([])
    }
    return json(written)
  }
  return json([])
})

const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.addInitScript(() => {
  const now = Math.floor(Date.now() / 1000)
  localStorage.setItem('sb-ekhvfypxuxskjglwwoqh-auth-token', JSON.stringify({
    access_token: 'stub', token_type: 'bearer', expires_in: 3600,
    expires_at: now + 3600, refresh_token: 'stub',
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'drive@test', aud: 'authenticated' },
  }))
})

await page.goto(BASE, { waitUntil: 'networkidle' })
ok('app boots signed in', await page.getByLabel('Open the menu').count() > 0)

/** Open a section from the menu. */
async function open(name) {
  await page.getByLabel('Open the menu').click()
  await page.waitForTimeout(250)
  await page.getByRole('menuitem', { name }).first().click()
  await page.waitForTimeout(600)
}
const addButtons = () => page.getByRole('button', { name: /^Add( waypoint)?$/ })

// --- the button is on every screen that lists waypoints --------------------
// Home is the landing screen and carries the nearest-waypoints card.
ok('Home, where the nearest waypoints are listed', await addButtons().count() > 0)

/*
 * Menu items are named by their label AND their hint, so a loose regex picks
 * the wrong row: /Waypoints/i matches Home, whose hint ends "…nearby
 * waypoints". Every one of these is anchored to the label for that reason —
 * the first version of this drive silently tested Home four times.
 */
for (const [section, heading] of [
  [/^Compass\b/, 'Compass'],
  [/^ETA to waypoint\b/, 'ETA'],
  [/^Live tracking\b/, 'Track'],
  [/^Waypoints\b/, 'Waypoints'],
]) {
  await open(section)
  const n = await addButtons().count()
  if (heading === 'Waypoints') {
    // The Waypoints tab is the one place that always had a full creator, so
    // what it gained is the map, not another button.
    ok('Waypoints, the full creator, offers Choose on map',
       await page.getByRole('button', { name: /Choose on map/i }).count() > 0,
       'heading: ' + (await page.locator('h2').first().textContent()))
  } else {
    ok(`${heading}, where waypoints are listed`, n > 0, `${n} control(s)`)
  }
}

// The Compass lists them twice — a bearings table and a pointer picker — and
// both got one.
await open(/^Compass\b/)
ok('Compass offers it against both of its lists', await addButtons().count() >= 2,
   `${await addButtons().count()} controls`)

// --- typing a position ------------------------------------------------------
await open(/^Home\b/)
await addButtons().first().click()
await page.waitForTimeout(400)
ok('the sheet opens', await page.getByRole('dialog', { name: /Add a waypoint/i }).count() > 0)

const sheet = page.getByRole('dialog', { name: /Add a waypoint/i })
ok('and offers the format selector, not a free-text box',
   await sheet.getByRole('radio', { name: 'DD', exact: true }).count() > 0
   && await sheet.getByRole('radio', { name: 'DDM', exact: true }).count() > 0
   && await sheet.getByRole('radio', { name: 'DMS', exact: true }).count() > 0)

await sheet.getByRole('radio', { name: 'DD', exact: true }).click()
await page.waitForTimeout(150)
ok('save is refused until there is a position',
   await sheet.getByRole('button', { name: /Save waypoint/i }).isDisabled())

await sheet.getByLabel(/Waypoint latitude, decimal degrees/i).fill('95')
await page.waitForTimeout(200)
// 95° of latitude does not exist. The strict parser is what refuses it, and
// this is the check that it is still the parser doing the work here.
ok('an impossible latitude is refused rather than saved',
   await sheet.getByRole('button', { name: /Save waypoint/i }).isDisabled())

await sheet.getByLabel(/Waypoint latitude, decimal degrees/i).fill('29.35')
await sheet.getByLabel(/Waypoint longitude, decimal degrees/i).fill('-94.78')
await page.getByPlaceholder(/^Name/).fill('Channel marker')
await page.waitForTimeout(250)
ok('and accepted once both axes read',
   !(await sheet.getByRole('button', { name: /Save waypoint/i }).isDisabled()))

// Switching format must carry the value across, not clear it.
await sheet.getByRole('radio', { name: 'DDM', exact: true }).click()
await page.waitForTimeout(250)
const ddmDeg = await sheet.getByLabel(/Waypoint latitude, degrees/i).inputValue()
const ddmMin = await sheet.getByLabel(/Waypoint latitude, minutes/i).inputValue()
ok('switching format keeps the position, in the new format',
   ddmDeg === '29' && Math.abs(parseFloat(ddmMin) - 21) < 0.1, `${ddmDeg}° ${ddmMin}'`)

await sheet.getByRole('button', { name: /Save waypoint/i }).click()
await page.waitForTimeout(600)
ok('the sheet closes on save',
   await page.getByRole('dialog', { name: /Add a waypoint/i }).count() === 0)
/*
 * Scoped to the list, not the page. The first version of this looked for the
 * name anywhere and passed with the waypoint saved into a team scope the list
 * filters out — it was matching the success toast, which carries the name.
 * Confirmed by breaking the scope on purpose: this check stayed green and only
 * the row assertion below went red.
 */
await page.waitForTimeout(400)
const listed = () => page.locator('li').filter({ hasText: 'Channel marker' })
ok('and the waypoint is in the list it was added from',
   await listed().count() > 0, `${await listed().count()} row(s)`)

const saved = written.find((w) => w.name === 'Channel marker')
ok('the row reaches the backend with the typed position', !!saved
   && Math.abs(saved.lat - 29.35) < 1e-6 && Math.abs(saved.lon - (-94.78)) < 1e-6,
   saved ? `${saved.lat}, ${saved.lon}` : 'no row')
// Nothing is scoped to a team in this drive, so a row that carried one would
// be invisible in every list it was added from.
ok('scoped to match the list beneath it', !!saved && saved.team_id === null,
   `team_id ${saved ? JSON.stringify(saved.team_id) : '—'}`)

// --- choosing on the map ----------------------------------------------------
await addButtons().first().click()
await page.waitForTimeout(400)
const sheet2 = page.getByRole('dialog', { name: /Add a waypoint/i })
// `count() >= 0` was the first version of this and is true of everything.
ok('no map until it is asked for',
   await sheet2.getByText(/Tap where the waypoint goes/i).count() === 0)
await sheet2.getByRole('button', { name: /Choose on map/i }).click()
await page.waitForTimeout(1200)
const map = sheet2.locator('[aria-label], div').filter({ hasText: /Tap where the waypoint goes/ }).first()
ok('the map opens with an instruction', await sheet2.getByText(/Tap where the waypoint goes/i).count() > 0)

// Tap left of centre: the position that lands in the boxes must be west of the
// fix, which is what proves the tap was unprojected rather than defaulted.
const box = await sheet2.locator('div').filter({ hasText: /Tap where the waypoint goes/ }).last().boundingBox()
  ?? await map.boundingBox()
const target = await sheet2.locator('svg').first().boundingBox()
const area = target ?? box
if (area) {
  await page.mouse.click(area.x + area.width * 0.3, area.y + area.height * 0.4)
  await page.waitForTimeout(500)
}
await sheet2.getByRole('radio', { name: 'DD', exact: true }).click()
await page.waitForTimeout(250)
const tappedLat = parseFloat(await sheet2.getByLabel(/Waypoint latitude, decimal degrees/i).inputValue())
const tappedLon = parseFloat(await sheet2.getByLabel(/Waypoint longitude, decimal degrees/i).inputValue())
ok('a tap fills the coordinate boxes',
   Number.isFinite(tappedLat) && Number.isFinite(tappedLon),
   `${tappedLat}, ${tappedLon}`)
/*
 * The tap was up and to the left of centre, so the position it produces has
 * to be north and west of the fix — and by more than the fix's own jitter,
 * or "it unprojected" and "it defaulted to the centre" look the same. Both
 * axes are checked because swapping them is the classic unprojection bug and
 * a longitude-only test passes straight through it.
 */
ok('with the place that was tapped, not the place the map was centred on',
   Number.isFinite(tappedLon) && Number.isFinite(tappedLat)
   && tappedLon < HERE.lon - 0.0005 && tappedLat > HERE.lat + 0.0002
   && Math.abs(tappedLon - HERE.lon) < 0.5,
   `tapped ${tappedLat}, ${tappedLon} against fix ${HERE.lat}, ${HERE.lon}`)

await page.getByPlaceholder(/^Name/).fill('Tapped point')
await sheet2.getByRole('button', { name: /Save waypoint/i }).click()
await page.waitForTimeout(600)
ok('a map-picked waypoint saves like a typed one',
   await page.locator('li').filter({ hasText: 'Tapped point' }).count() > 0)

// --- the awkward one: the chart plotter lists them inside a sheet -----------
await open(/^Chart plotter\b/)
const toWaypoint = page.getByRole('button', { name: /^Waypoint$/ }).first()
if (await toWaypoint.count() > 0) {
  await toWaypoint.click()
  await page.waitForTimeout(500)
  const inPicker = await page.getByRole('button', { name: /^Add waypoint$/ }).count()
  ok('the chart plotter’s waypoint picker offers it too', inPicker > 0)
  if (inPicker > 0) {
    await page.getByRole('button', { name: /^Add waypoint$/ }).first().click()
    await page.waitForTimeout(400)
    ok('and the sheet it opens is usable on top of the picker',
       await page.getByRole('dialog', { name: /Add a waypoint/i }).count() > 0
       && await page.getByPlaceholder(/^Name/).isVisible())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    ok('escape leaves the picker rather than stranding the crew',
       await page.getByRole('dialog', { name: /Add a waypoint/i }).count() === 0)
  }
} else {
  ok('the chart plotter’s waypoint picker offers it too', false, 'To: Waypoint chip not found')
}

// --- no sideways scroll ----------------------------------------------------
await open(/^Home\b/)
await addButtons().first().click()
await page.waitForTimeout(400)
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 844 })
  await page.waitForTimeout(250)
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(`no horizontal scroll at ${w} px with the sheet open`, over <= 0, `overflow ${over}px`)
}

ok('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
server.close()

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
