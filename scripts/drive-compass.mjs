/**
 * Headless drive of the production build: the compass, driven by synthetic
 * orientation events.
 *
 * This is the only way any of the compass work gets exercised end to end. A
 * unit test can check the arithmetic and a screenshot can check the artwork,
 * but neither can answer the questions that actually matter here — does the
 * sensor reach the dial, does the declination correction reach the number a
 * crew reads out, does the rose take the short way round north — and the last
 * session's log records exactly that failure mode: every unit test passing
 * against a steering card that could not advance a single leg in the app.
 *
 * Chromium constructs `DeviceOrientationEvent` with `absolute: true`, so the
 * whole path from the event listener to the rendered digits is the real one.
 *
 *   npm run build && node scripts/drive-compass.mjs
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

/*
 * Boston harbour, chosen because the declination there is about 14° west.
 * Somewhere on the agonic line would have let a broken true-north correction
 * pass unnoticed, which is the whole point of correcting it.
 */
const HERE = { lat: 42.355, lon: -71.03 }

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'block',
  permissions: ['geolocation'],
  geolocation: { latitude: HERE.lat, longitude: HERE.lon, accuracy: 5 },
})

/*
 * Two saved waypoints, so the waypoint pointer and the turn instruction are
 * exercised rather than only the bare dial. They are served by the stubbed
 * backend rather than seeded into localStorage, because the first load
 * replaces the cache with whatever the server says and an empty answer would
 * quietly delete them. They are also not stamped in the app: a waypoint
 * stamped here would be underfoot, and NavMate refuses to print a bearing to a
 * point you are standing on.
 */
const USER = '11111111-1111-4111-8111-111111111111'
const wp = (id, name, lat, lon) => ({
  id, user_id: USER, team_id: null, name, lat, lon,
  note: '', photos: [], created_at: '2026-09-13T00:00:00Z',
  updated_at: '2026-09-13T00:00:00Z',
})
const WAYPOINTS = [wp('w1', 'Datum', 42.372, -71.012), wp('w2', 'Boat ramp', 42.34, -71.05)]
await context.route('**://*.supabase.co/**', (r) => {
  const url = r.request().url()
  const body = /\/rest\/v1\/waypoints/.test(url) && r.request().method() === 'GET'
    ? JSON.stringify(WAYPOINTS)
    : '[]'
  return r.fulfill({ status: 200, contentType: 'application/json', body })
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

await page.getByLabel('Open the menu').click()
await page.waitForTimeout(300)
await page.getByRole('menuitem', { name: /Compass/i }).first().click()
await page.waitForTimeout(700)
ok('Compass opens', await page.getByRole('heading', { name: 'Compass', level: 2 }).count() > 0)

/** Hold one attitude for a while, at roughly the rate a phone reports. */
async function hold(alpha, beta, gamma, ms = 1400) {
  const steps = Math.max(1, Math.round(ms / 50))
  for (let i = 0; i < steps; i++) {
    await page.evaluate(
      (o) => {
        for (const name of ['deviceorientationabsolute', 'deviceorientation']) {
          window.dispatchEvent(new DeviceOrientationEvent(name, { ...o, absolute: true }))
        }
      },
      { alpha, beta, gamma },
    )
    await page.waitForTimeout(50)
  }
}

/** The number in the middle of the dial. */
const reading = async () => {
  const t = (await page.locator('[data-heading]').first().textContent()) ?? ''
  const n = parseInt(t.replace(/[^0-9]/g, ''), 10)
  return Number.isNaN(n) ? null : n
}
const caption = async () =>
  ((await page.locator('[data-caption]').first().textContent()) ?? '').trim()
const statValue = async (name) =>
  (await page.locator('dt', { hasText: name }).first().locator('xpath=../dd').innerText()).trim()
/** Shortest angular gap, for assertions. */
const apart = (a, b) => Math.abs((((b - a) % 360) + 540) % 360 - 180)

// --- before the sensor is started ------------------------------------------
ok('sits at no heading until the compass is started', (await reading()) === null,
   String(await reading()))
ok('offers to start it', await page.getByRole('button', { name: 'Start compass' }).count() > 0)

// --- start it and feed a flat phone pointing north -------------------------
await page.getByRole('button', { name: 'Start compass' }).click()
await page.waitForTimeout(200)
await hold(0, 0, 0)

const declText = await statValue('Variation')
ok('names the local magnetic variation', /^\d+(\.\d+)?° [EW]$/.test(declText), declText)
const declMag = parseFloat(declText)
const decl = /W$/.test(declText) ? -declMag : declMag
ok('variation is the westerly one Massachusetts actually has',
   decl < -12 && decl > -17, declText)

const north = await reading()
ok('shows true north as a magnetic reading corrected by the variation',
   north !== null && apart(north, (360 + decl) % 360) <= 1,
   `dial ${north}°, magnetic 0°, variation ${declText}`)
ok('says which north it is showing', /True/i.test(await caption()), await caption())
ok('and names the point of the compass', /NNW|NW|N\b/.test(await caption()), await caption())
ok('reports that it is reading the device, held flat',
   /Held flat/i.test(await statValue('Source')), await statValue('Source'))

// --- the reference toggle ---------------------------------------------------
await page.getByRole('button', { name: 'Mag', exact: true }).click()
await page.waitForTimeout(400)
const mag = await reading()
ok('switching to magnetic takes the correction back off',
   mag !== null && apart(mag, 0) <= 1, `${mag}°`)
ok('and relabels the dial', /Magnetic/i.test(await caption()), await caption())

// --- a flat phone turned through the compass -------------------------------
// Still in magnetic, so the expected reading is exactly 360 - alpha.
let sweepWorst = 0
for (const alpha of [45, 120, 200, 315]) {
  await hold(alpha, 0, 0, 900)
  const got = await reading()
  sweepWorst = Math.max(sweepWorst, apart(got, (360 - alpha) % 360))
}
ok('follows a flat phone round the whole compass', sweepWorst <= 2,
   `worst error ${sweepWorst.toFixed(1)}°`)

// --- the headline fix: a phone held up, rolled in the hand ------------------
// Held upright, a roll of the wrist and a turn of the body are the same number
// to `alpha`. These five attitudes are all the same physical direction; the
// old compass read five different headings for them.
const rolled = []
for (const gamma of [-40, -20, 0, 20, 40]) {
  await hold((360 + 30 - gamma) % 360, 90, gamma, 900)
  rolled.push(await reading())
}
const spread = Math.max(...rolled.map((r) => apart(r, rolled[0])))
ok('holds one heading while the phone is rolled in the hand',
   spread <= 3, `readings ${rolled.join(', ')}`)
ok('and that heading is the right one', apart(rolled[0], 330) <= 3, `${rolled[0]}°`)
ok('notices the phone is being held up rather than flat',
   /Held up/i.test(await statValue('Source')), await statValue('Source'))

// --- raising the phone must not move the needle ----------------------------
// Worth being straight about what this one proves: with no roll, the old
// alpha-only reading is also correct at every pitch, and this check passes
// against it (confirmed by putting the old code back). It is a regression
// guard on the hand-over between the two pointers, not evidence of the fix —
// the roll test above is the evidence.
let liftWorst = 0
for (const beta of [0, 20, 40, 55, 70, 85]) {
  await hold(30, beta, 0, 700)
  liftWorst = Math.max(liftWorst, apart(await reading(), 330))
}
ok('keeps the heading as the phone is raised from flat to eye height',
   liftWorst <= 3, `worst error ${liftWorst.toFixed(1)}°`)

// --- the rose takes the short way round north ------------------------------
const drawn = async () => {
  const t = await page.locator('[data-rose]').getAttribute('transform')
  return parseFloat((t || '').replace(/[^0-9.\-]/g, ''))
}
await hold(2, 0, 0, 1200)   // dial reads 358 magnetic
const before = await drawn()
await hold(358, 0, 0, 1200) // dial reads 2 magnetic — four degrees on
const after = await drawn()
ok('the dial crosses north the short way instead of unwinding 356°',
   Math.abs(Math.abs(after - before) - 4) < 3,
   `drawn ${before.toFixed(1)}° then ${after.toFixed(1)}°`)

// --- level, and the warning for a badly held phone -------------------------
await hold(30, 0, 0, 800)
const bubbleLevel = await page.locator('svg circle[r="3.4"]').getAttribute('cy')
ok('the bubble sits in the middle when the phone is flat',
   Math.abs(parseFloat(bubbleLevel)) < 1, `cy ${bubbleLevel}`)
await hold(30, -45, 0, 1800)
const bubbleTilted = await page.locator('svg circle[r="3.4"]').getAttribute('cy')
ok('and moves off centre when it is not',
   Math.abs(parseFloat(bubbleTilted)) > 3, `cy ${bubbleTilted}`)
ok('warns that the phone is being held too far off level',
   await page.getByText(/off level/i).count() > 0)

// --- a boat coming round is not a broken compass ---------------------------
// The first version of the steadiness test only looked at how far the readings
// moved, which called a hard turn a fault and told the coxswain to stop and
// wave the phone about. Swing it 90° over two seconds and it must stay quiet.
await hold(30, 0, 0, 1400)
for (let i = 0; i <= 40; i++) {
  await page.evaluate(
    (a) => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientationabsolute',
        { alpha: a, beta: 0, gamma: 0, absolute: true })),
    (360 + 30 - i * 2.25) % 360,
  )
  await page.waitForTimeout(50)
}
ok('a steady turn is not reported as a compass fault',
   !/Poor/i.test(await statValue('Steadiness')), await statValue('Steadiness'))

// Mid-turn the needle is behind the boat by the filter's time constant times
// the rate of turn — about 8° at this rate, which is 45°/s and faster than
// anything this app will be on. What matters is that it is a bounded lag and
// not a needle that has lost the plot.
const midTurn = await reading()
ok('the dial follows a turn without falling behind it',
   apart(midTurn, 60) <= 12, `${midTurn}° against 60°, lag ${apart(midTurn, 60)}°`)
// And that it catches up as soon as the boat steadies, which is when the
// number is actually read.
await hold(300, 0, 0, 1200)
const settled = await reading()
ok('and catches up within a second of steadying on the new course',
   apart(settled, 60) <= 2, `${settled}° against 60°`)

// --- a magnetometer that will not settle -----------------------------------
// Scattering the raw readings while the attitude holds still is exactly what
// an uncalibrated or disturbed magnetometer does, and the only signal Android
// gives at all.
for (let i = 0; i < 30; i++) {
  await page.evaluate(
    (a) => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientationabsolute',
        { alpha: a, beta: 0, gamma: 0, absolute: true })),
    (i % 2 === 0 ? 30 : 90),
  )
  await page.waitForTimeout(40)
}
await page.waitForTimeout(200)
ok('calls a wandering magnetometer what it is',
   /Poor/i.test(await statValue('Steadiness')), await statValue('Steadiness'))
ok('and says how to fix it',
   await page.getByText(/figure of eight/i).count() > 0)

// Settle it again so the rest of the drive is not run against a bad reading.
await hold(30, 0, 0, 1600)
ok('recovers once the readings settle',
   /Good|±/.test(await statValue('Steadiness')), await statValue('Steadiness'))

// --- taking a bearing ------------------------------------------------------
await page.getByRole('button', { name: 'Take a bearing' }).click()
await page.waitForTimeout(200)
const held = await page.locator('li', { hasText: /° M/ }).first().innerText()
ok('holds a sighted bearing so it can be read after the phone is lowered',
   /\d+° M/.test(held), held.replace(/\n/g, ' '))
await page.getByRole('button', { name: 'Clear' }).click()
await page.waitForTimeout(150)
ok('and lets it go again', await page.locator('li', { hasText: /° M/ }).count() === 0)

// --- pointing at a waypoint ------------------------------------------------
await hold(30, 0, 0, 1000)   // heading 330 magnetic
await page.locator('select').selectOption({ label: 'Datum' })
await page.waitForTimeout(400)
ok('marks the waypoint on the rose', await page.locator('polygon.fill-sky-400').count() > 0)
const legLine = await page.locator('p', { hasText: /NM/ }).first().innerText()
// The datum is north-east of the fix, and the phone is pointing north-west, so
// the turn is to the right. Getting this sign wrong is the difference between
// steering towards the casualty and away from them.
ok('gives the bearing, the range and which way to turn for it',
   /\d+° (NE|ENE|NNE)/.test(legLine) && /\d+\.\d+ NM/.test(legLine) &&
   /turn \d+° right/.test(legLine), legLine.replace(/\n/g, ' '))

// --- the bearings table ----------------------------------------------------
const table = await page.locator('ul li', { hasText: /NM/ }).first().innerText()
ok('lists the saved waypoints nearest first with a true bearing to each',
   /Boat ramp/.test(table) && /° [NSEW]/.test(table), table.replace(/\n/g, ' '))
ok('explains that the table is true and the dial says which it is',
   await page.getByText(/Bearings are true/i).count() > 0)

// --- stopping ---------------------------------------------------------------
await page.getByRole('button', { name: 'Stop compass' }).click()
await page.waitForTimeout(300)
ok('stops on request rather than draining the battery all shift',
   (await reading()) === null)

// --- the preference survives a reload --------------------------------------
await page.reload({ waitUntil: 'networkidle' })
await page.getByLabel('Open the menu').click()
await page.waitForTimeout(300)
await page.getByRole('menuitem', { name: /Compass/i }).first().click()
await page.waitForTimeout(700)
const pressed = await page
  .getByRole('button', { name: 'Mag', exact: true })
  .getAttribute('aria-pressed')
ok('remembers whether the crew asked for true or magnetic', pressed === 'true',
   `aria-pressed ${pressed}`)

// --- no sideways scroll ----------------------------------------------------
await page.getByRole('button', { name: 'Start compass' }).click()
await hold(30, 20, 10, 400)
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 844 })
  await page.waitForTimeout(250)
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(`no horizontal scroll at ${w} px`, over <= 0, `overflow ${over}px`)
  const dial = await page.locator('svg').first().boundingBox()
  ok(`the dial fits the ${w} px screen`, dial && dial.width <= w - 24,
     `${Math.round(dial?.width ?? 0)}px wide`)
}

ok('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
server.close()

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
