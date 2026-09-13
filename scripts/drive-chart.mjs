/**
 * Headless drive of the production build: chart plotter end to end against a
 * stubbed NOAA. Service workers are blocked — Playwright route stubs do not
 * intercept SW fetches (recorded in CLAUDE.md from an earlier session).
 */
// Playwright is not a project dependency — it is present in the build image
// and in most dev environments globally. Resolve it either way rather than
// adding 300 MB of browsers to everyone's `npm install`.
//   npm run build && node scripts/drive-chart.mjs
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

// --- the stubbed world -----------------------------------------------------
// Galveston-ish. Deep water everywhere, a shoal bar across the direct line
// with a channel down the east side, and a wreck in the channel's mouth.
const START = { lat: 29.30, lon: -94.82 }
const DEST  = { lat: 29.34, lon: -94.82 }

const ring = (minLat, minLon, maxLat, maxLon) => [[
  [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat],
]]

const LAYERS = { layers: [
  { id: 40, name: 'Harbor.Depth_Area_area', geometryType: 'esriGeometryPolygon' },
  { id: 60, name: 'Harbor.Land_Area_area', geometryType: 'esriGeometryPolygon' },
  { id: 90, name: 'Harbor.Wrecks_point', geometryType: 'esriGeometryPoint' },
]}

// 1×1 transparent PNG for every tile request.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64')

const tileHits = { chart: 0, seamark: 0, imagery: 0 }
const encHits = []

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'block',
  permissions: ['geolocation'],
  geolocation: { latitude: START.lat, longitude: START.lon, accuracy: 5 },
})

await context.route('**://gis.charttools.noaa.gov/**', (r) => {
  tileHits.chart++
  encHits.push(r.request().url())
  r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
})
await context.route('**://tiles.openseamap.org/**', (r) => {
  tileHits.seamark++
  r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
})
await context.route('**://server.arcgisonline.com/**', (r) => {
  tileHits.imagery++
  r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
})
await context.route('**://encdirect.noaa.gov/**', (r) => {
  const url = r.request().url()
  encHits.push(url)
  const json = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (url.includes('/layers?f=json')) return json(LAYERS)
  if (url.includes('/40/query')) return json({ features: [
      { geometry: { type:'Polygon', coordinates: ring(29.20, -94.95, 29.45, -94.70) }, properties: { DRVAL1: 12 } },
      // The bar: 0.3 m, from the west shore out to -94.806, blocking the direct line.
      { geometry: { type:'Polygon', coordinates: ring(29.315, -94.95, 29.325, -94.806) }, properties: { DRVAL1: 0.3 } },
  ]})
  if (url.includes('/60/query')) return json({ features: [] })
  if (url.includes('/90/query')) return json({ features: [] })
  return json({ features: [] })
})
// Supabase: accept writes, serve them back, so the vessel store behaves.
const rows = { vessels: [] }
await context.route('**://*.supabase.co/**', async (r) => {
  const url = r.request().url()
  const method = r.request().method()
  const json = (o, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) })
  if (url.includes('/auth/v1/')) return json({})
  const table = (url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1]
  if (!table) return json([])
  if (method === 'POST' || method === 'PATCH') {
    try {
      const body = JSON.parse(r.request().postData() || '{}')
      const list = Array.isArray(body) ? body : [body]
      rows[table] = [...(rows[table] || []).filter((x) => !list.some((y) => y.id === x.id)), ...list]
    } catch { /* ignore */ }
    return json([])
  }
  if (method === 'DELETE') return json([])
  return json(rows[table] || [])
})

const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

// Seed a signed-in session before the app boots.
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

// --- open the Chart plotter section ---------------------------------------
const openChart = async () => {
  await page.getByLabel('Open the menu').click()
  await page.waitForTimeout(300)
  await page.getByRole('menuitem', { name: /Chart plotter/i }).first().click()
  await page.waitForTimeout(600)
}
await page.getByLabel('Open the menu').click()
await page.waitForTimeout(300)
const chartEntry = page.getByRole('menuitem', { name: /Chart plotter/i })
ok('Chart plotter is listed in the menu', await chartEntry.count() > 0)
await chartEntry.first().click()
await page.waitForTimeout(500)
ok('Chart plotter opens', await page.getByRole('heading', { name: 'Chart plotter' }).count() > 0)

// --- add a boat ------------------------------------------------------------
ok('asks for a boat before it will plan anything',
   (await page.getByText(/Add your boat so the plotter knows/i).count()) > 0)

await page.getByLabel('Boat name').fill('Marine 2')
await page.getByLabel('Draft in feet', { exact: true }).fill('3')
await page.getByLabel('Under-keel margin in feet').fill('2')
await page.getByLabel('Cruise speed in knots').fill('20')
await page.getByLabel('Stand-off from hazards in feet').fill('0')
await page.getByRole('button', { name: 'Add boat' }).click()
await page.waitForTimeout(600)

const needs = await page.locator('text=/draft \\+ margin/i').count()
ok('boat saved and its required depth shown', needs > 0)
const draftStat = await page.locator('div', { hasText: /^Draft$/ }).count()
ok('draft shown in feet', (await page.getByText('3.0 ft').count()) > 0)

// --- chart layer -----------------------------------------------------------
await page.waitForTimeout(800)
ok('NOAA chart tiles requested', tileHits.chart > 0, `${tileHits.chart} tiles`)
ok('seamark overlay requested', tileHits.seamark > 0, `${tileHits.seamark} tiles`)
const chartUrl = encHits.find((u) => u.includes('GetMap'))
ok('chart requested as a WMS GetMap in EPSG:3857',
   !!chartUrl && chartUrl.includes('crs=EPSG:3857') && /bbox=-?\d+\.?\d*,/.test(chartUrl))

// --- start point, then destination ----------------------------------------
ok('destination is gated until a start point is set',
   (await page.getByText(/Waiting on a start point/i).count()) > 0
   && (await page.getByRole('button', { name: 'Pick destination' }).isDisabled()))

ok('start card offers both ways in',
   (await page.getByRole('button', { name: 'Use current location' }).count()) > 0
   && (await page.getByRole('button', { name: 'Select on map' }).count()) > 0)

await page.getByRole('button', { name: 'Use current location' }).click()
await page.waitForTimeout(700)
ok('current location became the start point',
   (await page.getByText('Current location').count()) > 0)

await page.getByRole('button', { name: 'Pick destination' }).click()
await page.waitForTimeout(200)
ok('pick hint shown over the chart',
   (await page.getByText(/Tap the chart where you want to go/i).count()) > 0)

// Click above the middle of the map — north of the start. The app header is
// fixed, so the point has to clear it or the header eats the tap.
const tapMap = async () => {
  const map = page.locator('div.relative.touch-none').first()
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const b = await map.boundingBox()
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2 - 60)
  await page.waitForTimeout(400)
}
await tapMap()
ok('tap set a destination', (await page.getByText('Picked on chart').count()) > 0)

// Both the start and destination cards show a latitude now, so look for any
// of them that is north of the mocked fix — that can only be the tapped one.
const latTexts = await page.locator('.tnum').allTextContents()
const lats = latTexts
  .map((t) => parseFloat((t.match(/(\d{2}\.\d{4,})/) ?? [])[1] ?? 'NaN'))
  .filter(Number.isFinite)
ok('the tap unprojected to a position north of the fix',
   lats.some((v) => v > START.lat), `latitudes on screen: ${lats.join(', ')}`)

// Now set the real destination by typing it, which also exercises that path
// and puts the bar between us and it.
await page.getByLabel('Destination latitude').fill(String(DEST.lat))
await page.getByLabel('Destination longitude').fill(String(DEST.lon))
await page.getByRole('button', { name: 'Use typed coordinates' }).click()
await page.waitForTimeout(400)
ok('typed coordinates accepted', (await page.getByText('Typed position').count()) > 0)

// --- plot the course -------------------------------------------------------
await page.getByRole('button', { name: 'Plot course' }).click()
await page.waitForTimeout(2500)

const legRows = await page.getByText(/least|not charted/).count()
const directNM = 60 * (DEST.lat - START.lat)
const shownNM = parseFloat((await page.getByText(/NM$/).first().textContent()) ?? 'NaN')
ok('a multi-leg course was plotted', legRows >= 2, `${legRows} legs`)
ok('it went round the bar rather than over it',
   Number.isFinite(shownNM) && shownNM > directNM + 0.1,
   `${shownNM} NM plotted vs ${directNM.toFixed(2)} NM direct`)
ok('ENC depth areas were queried', encHits.some((u) => u.includes('/40/query')))
ok('layer ids were discovered, not hardcoded', encHits.some((u) => u.includes('/layers?f=json')))

const distTile = await page.locator('div', { hasText: /^Distance$/ }).first()
const distVal = await page.getByText(/NM$/).first().textContent()
ok('distance shown in NM', !!distVal && /NM/.test(distVal), distVal ?? '')
ok('time to run shown', (await page.getByText(/at 20 kn/).count()) > 0)
ok('arrival clock shown', (await page.locator('div', { hasText: /^Arrive$/ }).count()) > 0)
ok('not-for-navigation banner shown with the route',
   (await page.getByText(/Not for navigation/i).count()) > 0)
ok('least charted depth shown per leg', (await page.getByText(/least/).count()) > 0)

// The route must not cross the bar: read the plotted legs' least depths.
const leastTexts = await page.getByText(/least/).allTextContents()
const leasts = leastTexts.map((t) => parseFloat(t.match(/([\d.]+) ft least/)?.[1] ?? 'NaN'))
const needFt = 5 * 1.0  // 3 ft draft + 2 ft margin
ok('no leg crosses water shallower than the boat needs',
   leasts.every((d) => !Number.isFinite(d) || d >= needFt - 0.05),
   `least depths: ${leasts.join(', ')} ft (needs ${needFt} ft)`)

// --- steering --------------------------------------------------------------
await page.getByRole('button', { name: 'Steer this route' }).click()
await page.waitForTimeout(400)
ok('steering card appears', (await page.getByText(/^Steering$/).count()) > 0)
const steerLine = await page.locator('.text-2xl').first().textContent()
ok('a course to steer is shown', !!steerLine && /°|Here/.test(steerLine), steerLine ?? '')

// --- save as waypoints -----------------------------------------------------
await page.getByRole('button', { name: 'Save as waypoints' }).click()
await page.waitForTimeout(900)
ok('route points saved as waypoints',
   (rows.waypoints?.length ?? 0) >= 2, `${rows.waypoints?.length ?? 0} rows`)

// --- degradation: kill the ENC service -------------------------------------
await context.unroute('**://encdirect.noaa.gov/**')
await context.route('**://encdirect.noaa.gov/**', (r) => r.fulfill({ status: 503, body: '' }))
await page.evaluate(() => localStorage.removeItem('navmate.chart.v1'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(700)
await openChart()
await page.getByRole('button', { name: 'Use current location' }).click()
await page.waitForTimeout(700)
await page.getByLabel('Destination latitude').fill(String(DEST.lat))
await page.getByLabel('Destination longitude').fill(String(DEST.lon))
await page.getByRole('button', { name: 'Use typed coordinates' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Plot course' }).click()
await page.waitForTimeout(2500)
ok('a dead chart service degrades to a straight line with a warning',
   (await page.getByText(/No charted depths for this area/i).count()) > 0)

// --- no sideways scroll ----------------------------------------------------
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 844 })
  await page.waitForTimeout(250)
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(`no horizontal scroll at ${w} px`, over <= 0, `overflow ${over}px`)
}

ok('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
server.close()

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
