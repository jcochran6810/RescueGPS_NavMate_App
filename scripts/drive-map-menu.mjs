/**
 * Headless drive of the production build: press and hold on a map, and the
 * full-screen map.
 *
 * Neither of these is unit-testable. A press is a gesture that has to be told
 * apart from a tap and from a pan by timing and by a few pixels of movement;
 * full screen is a container that has to actually fill the screen and give the
 * page back afterwards. What can go wrong is what only a browser sees: a menu
 * that opens on a drag, a position that reads off the centre of the map rather
 * than the finger, a menu whose buttons never receive their click because the
 * map unmounted them on the way down, a map that covers the screen and cannot
 * be got out of.
 *
 *   npm run build && node scripts/drive-map-menu.mjs
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
  permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
  geolocation: { latitude: HERE.lat, longitude: HERE.lon, accuracy: 5 },
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64')
for (const host of ['server.arcgisonline.com', 'gis.charttools.noaa.gov', 'tiles.openseamap.org']) {
  await context.route(`**://${host}/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
}

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

async function open(name) {
  await page.getByLabel('Open the menu').click()
  await page.waitForTimeout(250)
  await page.getByRole('menuitem', { name }).first().click()
  await page.waitForTimeout(600)
}

/** The map's own box, which is the element the gestures are delivered to. */
const mapBox = () => page.locator('div.touch-none').first()

/** Press and hold, without moving — which is what a press is. */
async function press(x, y, ms = 800) {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(ms)
  await page.mouse.up()
  await page.waitForTimeout(250)
}

const menu = () => page.getByRole('menu', { name: /Place on the map/i })

// --- a map with a position on it -------------------------------------------
await open(/^Live tracking\b/)
await page.getByRole('button', { name: /Start tracking/i }).click()
await page.waitForTimeout(1200)
await mapBox().scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
const box = await mapBox().boundingBox()
/*
 * The map must be *inside the viewport* before anything is pressed on it, and
 * this check exists because the first version of this drive did not have it:
 * the tracker map sits below the fold, every press landed off screen, and the
 * two "nothing happened" checks below passed for the wrong reason while the
 * press check failed. A gesture drive that does not assert it is hitting
 * something is asserting nothing at all.
 */
const vp = page.viewportSize()
ok('the tracker map is on screen and can be pressed',
   !!box && box.height > 100 && box.y >= 0 && box.y + box.height <= vp.height,
   box ? `${Math.round(box.width)}×${Math.round(box.height)} at y=${Math.round(box.y)}` : 'no box')

// Away from the controls: the zoom stack is top-right, Centre is bottom-right.
const spot = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 }

// --- a short tap is not a press --------------------------------------------
await page.mouse.click(spot.x, spot.y)
await page.waitForTimeout(300)
ok('a tap opens nothing — a map that is not a picker stays a map',
   await menu().count() === 0)

// --- a drag is not a press either ------------------------------------------
await page.mouse.move(spot.x, spot.y)
await page.mouse.down()
await page.mouse.move(spot.x + 60, spot.y + 20, { steps: 8 })
await page.waitForTimeout(700)
await page.mouse.up()
await page.waitForTimeout(300)
ok('a pan does not open the menu, however long the finger is down',
   await menu().count() === 0)

// Put the map back under the boat so the geometry below is known.
await page.getByRole('button', { name: /Centre on my position/i }).click()
await page.waitForTimeout(500)

// --- the press itself -------------------------------------------------------
await press(spot.x, spot.y)
ok('press and hold opens the menu', await menu().count() > 0)

/*
 * The readout has to be the place under the finger, not the middle of the map.
 * The press was up and to the left of centre, so the position must be north
 * AND west of the fix — both axes, because swapping them is the classic
 * unprojection bug and a one-axis check walks straight through it.
 */
const readout = (await menu().locator('p').first().textContent()) ?? ''
const m = readout.match(/(\d+)°\s*([\d.]+)'\s*([NS])\s+(\d+)°\s*([\d.]+)'\s*([EW])/)
const pressedLat = m ? (+m[1] + +m[2] / 60) * (m[3] === 'S' ? -1 : 1) : NaN
const pressedLon = m ? (+m[4] + +m[5] / 60) * (m[6] === 'W' ? -1 : 1) : NaN
ok('it reads the position under the finger, in the crew’s own format',
   Number.isFinite(pressedLat) && Number.isFinite(pressedLon), readout.trim())
ok('and it is the place pressed, not the place the map was centred on',
   pressedLat > HERE.lat + 0.0002 && pressedLon < HERE.lon - 0.0005
   && Math.abs(pressedLon - HERE.lon) < 0.5,
   `pressed ${pressedLat.toFixed(5)}, ${pressedLon.toFixed(5)} against fix ${HERE.lat}, ${HERE.lon}`)
ok('with the range and bearing from the boat, which is the field question',
   /NM|ft|m\b/.test((await menu().locator('p').nth(1).textContent()) ?? '')
   && /from here/i.test((await menu().locator('p').nth(1).textContent()) ?? ''),
   ((await menu().locator('p').nth(1).textContent()) ?? '').trim())
ok('and offers both of the things a crew does with a place',
   await menu().getByRole('menuitem', { name: /Save as waypoint/i }).count() > 0
   && await menu().getByRole('menuitem', { name: /Navigate here/i }).count() > 0)

// --- save as waypoint -------------------------------------------------------
await menu().getByRole('menuitem', { name: /Save as waypoint/i }).click()
await page.waitForTimeout(600)
const sheet = page.getByRole('dialog', { name: /Add a waypoint/i })
ok('“Save as waypoint” opens the one waypoint creator this app has',
   await sheet.count() > 0)
await sheet.getByRole('radio', { name: 'DD', exact: true }).click()
await page.waitForTimeout(200)
const filledLat = parseFloat(await sheet.getByLabel(/Waypoint latitude, decimal degrees/i).inputValue())
const filledLon = parseFloat(await sheet.getByLabel(/Waypoint longitude, decimal degrees/i).inputValue())
ok('already filled in with the pressed position',
   Math.abs(filledLat - pressedLat) < 1e-4 && Math.abs(filledLon - pressedLon) < 1e-4,
   `${filledLat}, ${filledLon} against ${pressedLat.toFixed(5)}, ${pressedLon.toFixed(5)}`)

await page.getByPlaceholder(/^Name/).fill('Pressed point')
await sheet.getByRole('button', { name: /Save waypoint/i }).click()
await page.waitForTimeout(700)
const saved = written.find((w) => w.name === 'Pressed point')
ok('and saving it writes the pressed position, not the boat’s',
   !!saved && Math.abs(saved.lat - pressedLat) < 1e-4
   && Math.abs(saved.lon - pressedLon) < 1e-4,
   saved ? `${saved.lat}, ${saved.lon}` : 'no row')
ok('the sheet closes behind it',
   await page.getByRole('dialog', { name: /Add a waypoint/i }).count() === 0)

// --- navigate here ----------------------------------------------------------
await press(spot.x, spot.y)
ok('the menu opens again on the same map', await menu().count() > 0)
await menu().getByRole('menuitem', { name: /Navigate here/i }).click()
await page.waitForTimeout(1200)
ok('“Navigate here” hands the place to the chart plotter and goes there',
   await page.getByText(/Chart plotter|Plot a course/i).count() > 0,
   (await page.locator('h2').first().textContent() ?? '').trim())
const destText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
ok('with the pressed place set as the destination',
   /Dropped pin/i.test(destText))

// --- full screen ------------------------------------------------------------
await open(/^Live tracking\b/)
await page.waitForTimeout(800)
await mapBox().scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
const before = await mapBox().boundingBox()
await page.getByRole('button', { name: /^Full screen$/i }).click()
await page.waitForTimeout(500)
const after = await mapBox().boundingBox()
const view = page.viewportSize()
ok('full screen actually fills the screen',
   !!after && after.height > before.height * 2 && after.height > view.height * 0.8,
   after ? `${Math.round(before.height)}px → ${Math.round(after.height)}px of ${view.height}` : 'no box')
ok('and the page behind it cannot scroll under it',
   await page.evaluate(() => getComputedStyle(document.body).overflow) === 'hidden')

// The press menu has to work on a map that is now the whole screen, and
// Escape has to take the menu before it takes the map — one key, two jobs,
// never both at once.
await press(view.width * 0.4, view.height * 0.45)
ok('press and hold still works full screen', await menu().count() > 0)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
ok('escape closes the menu first',
   await menu().count() === 0
   && (await mapBox().boundingBox()).height > view.height * 0.8)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
const back = await mapBox().boundingBox()
ok('and escape again gives the page back',
   back.height < view.height * 0.6, `${Math.round(back.height)}px`)
ok('with the page scrollable again',
   await page.evaluate(() => getComputedStyle(document.body).overflow) !== 'hidden')

// --- the picker map does not offer a second creator -------------------------
await page.getByRole('button', { name: /^Add waypoint$/ }).first().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /Choose on map/i }).click()
await page.waitForTimeout(1200)
const pickerBox = await page.getByRole('dialog').locator('div.touch-none').first().boundingBox()
if (pickerBox) {
  await press(pickerBox.x + pickerBox.width * 0.4, pickerBox.y + pickerBox.height * 0.4)
  ok('a press inside a picker offers the pick itself',
     await menu().getByRole('menuitem', { name: /Use this point/i }).count() > 0)
  /*
   * And not "save as waypoint" — that would open a second add-waypoint sheet
   * on top of the one being filled in, which is the state this arrangement
   * exists to avoid.
   */
  ok('and not a second waypoint sheet on top of the one being filled in',
     await menu().getByRole('menuitem', { name: /Save as waypoint/i }).count() === 0)
  await menu().getByRole('menuitem', { name: /Use this point/i }).click()
  await page.waitForTimeout(400)
  await page.getByRole('dialog').getByRole('radio', { name: 'DD', exact: true }).click()
  await page.waitForTimeout(250)
  const usedLat = parseFloat(await page.getByLabel(/Waypoint latitude, decimal degrees/i).inputValue())
  ok('and it fills the boxes like a tap does', Number.isFinite(usedLat), String(usedLat))
} else {
  ok('a press inside a picker offers the pick itself', false, 'no picker map')
}
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// --- no sideways scroll -----------------------------------------------------
await open(/^Live tracking\b/)
await page.getByRole('button', { name: /^Full screen$/i }).click()
await page.waitForTimeout(400)
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 844 })
  await page.waitForTimeout(250)
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(`no horizontal scroll at ${w} px full screen`, over <= 0, `overflow ${over}px`)
}

ok('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
server.close()

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
