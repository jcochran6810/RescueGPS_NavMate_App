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

// --- the compass is live on arrival ----------------------------------------
// Chromium exposes no DeviceOrientationEvent.requestPermission, so this is the
// non-iOS path: the sensor starts itself and there is nothing to press.
ok('no start button — the compass runs on opening the page',
   (await page.getByRole('button', { name: /start compass/i }).count()) === 0
   && (await page.getByRole('button', { name: /allow motion access/i }).count()) === 0)

// It listens before any reading arrives, which is what makes it ready: feed a
// single event and a heading is there, with nothing tapped in between.
await hold(0, 0, 0)
await page.waitForTimeout(300)
ok('a heading appears from the first event, with nothing tapped',
   (await reading()) !== null, String(await reading()))

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
// There is no Stop button any more, because there is no Start: leaving the
// page is what stops it. That has to be proved rather than assumed — a
// magnetometer left running behind another screen is exactly the battery this
// app cannot spend, and it would now be invisible.
await page.getByLabel('Open the menu').click()
await page.waitForTimeout(300)
await page.getByRole('menuitem', { name: /Convert/i }).first().click()
await page.waitForTimeout(400)
// What a browser can actually witness is that the card unmounted, which is
// what runs the cleanup that stops the sensor. Counting listeners from page
// script cannot see a listener this page added, so a check that tried would be
// theatre — said here rather than dressed up as evidence.
ok('leaving the compass page tears the card down, which is what stops the sensor',
   (await page.getByText(/Variation/i).count()) === 0)

await page.getByLabel('Open the menu').click()
await page.waitForTimeout(300)
await page.getByRole('menuitem', { name: /Compass/i }).first().click()
await page.waitForTimeout(500)
ok('and it is live again the moment the page is reopened, still with no button',
   (await page.getByRole('button', { name: /start compass/i }).count()) === 0)
await hold(0, 0, 0)
await page.waitForTimeout(300)
ok('a reopened compass reads again from the first event',
   (await reading()) !== null, String(await reading()))

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


/* ------------------------------------------------ the map under the compass */
/*
 * Rotation is the thing that cannot be checked by reading code: the transform
 * can be right and the gestures wrong, or the map turned and the labels
 * upside down. So the drive reads the transform back out of the DOM and then
 * taps the turned map to see where the tap actually lands.
 */
const mapBtn = page.getByRole('button', { name: /Show the map under the compass/i })
ok('the map is offered, not forced', await mapBtn.count() > 0)
await mapBtn.click()
await page.waitForTimeout(1200)

ok('and all three layers are offered',
   await page.getByRole('radio', { name: /^Satellite$/ }).count() > 0
   && await page.getByRole('radio', { name: /^Hybrid$/ }).count() > 0
   && await page.getByRole('radio', { name: /^Chart$/ }).count() > 0)

/** The rotation actually applied to the ground, in degrees. */
const groundDeg = async () => await page.evaluate(() => {
  const box = document.querySelector('div.touch-none')
  if (!box) return null
  const layer = box.querySelector('div.pointer-events-none.absolute.inset-0')
  if (!layer) return null
  const t = getComputedStyle(layer).transform
  if (!t || t === 'none') return 0
  const m = t.match(/matrix\(([^)]+)\)/)
  if (!m) return 0
  const [a, b] = m[1].split(',').map(Number)
  return Math.round(((Math.atan2(b, a) * 180) / Math.PI + 360) % 360)
})

/** A flat phone facing `deg` magnetic: alpha is the azimuth of the top edge. */
const setHeading = (deg) => hold((360 - deg) % 360, 0, 0, 1400)

await setHeading(0)
const at0 = await groundDeg()
await setHeading(90)
const at90 = await groundDeg()
await setHeading(200)
const at200 = await groundDeg()

/** Signed difference between two angles, -180..180. */
const delta = (a, b) => (((a - b) % 360) + 540) % 360 - 180

/*
 * Head-up means the ground turns the OPPOSITE way to the heading: face east
 * and east has to come round to the top of the screen, so the ground goes
 * anticlockwise by 90. Getting the sign backwards is the classic way to ship
 * a map that turns the wrong way and still "rotates".
 */
const near = (a, b, tol = 12) => a !== null && Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= tol
ok('the ground turns with the heading', !near(at0, at90, 20) && !near(at90, at200, 20),
   `${at0}° → ${at90}° → ${at200}°`)
/*
 * Compared as *changes*, not absolutes: the dial is corrected to true north,
 * so the rotation carries the local declination and asserting "heading 90 →
 * ground 270" would be asserting the declination is zero. The difference
 * cancels it, and is what actually has to be right — turn 90° right and the
 * ground turns 90° left under you.
 */
ok('and turns the right way — the heading comes to the top of the screen',
   Math.abs(delta(at90, at0) + 90) <= 12 && Math.abs(delta(at200, at90) + 110) <= 12,
   `+90° of heading moved the ground ${Math.round(delta(at90, at0))}°, ` +
   `+110° moved it ${Math.round(delta(at200, at90))}°`)

/*
 * The arrangement the crew asked for: one view, dial on the ground, not a
 * picture beside one. Checked by geometry rather than by the presence of two
 * elements — the rose has to sit *inside* the map box and be centred on it,
 * which is what makes it a rose on a chart.
 */
const overlay = await page.evaluate(() => {
  const box = document.querySelector('div.touch-none')
  const rose = document.querySelector('svg[viewBox="-100 -100 200 200"]')
  if (!box || !rose) return null
  const b = box.getBoundingClientRect()
  const r = rose.getBoundingClientRect()
  return {
    inside: r.left >= b.left - 2 && r.right <= b.right + 2 && r.top >= b.top - 2 && r.bottom <= b.bottom + 2,
    centred: Math.abs((r.left + r.right) / 2 - (b.left + b.right) / 2) < 4
      && Math.abs((r.top + r.bottom) / 2 - (b.top + b.bottom) / 2) < 4,
    facePaint: (() => {
      const face = rose.querySelector('circle')
      return face ? face.getAttribute('fill') : null
    })(),
  }
})
ok('the dial is drawn on the map, centred on it', !!overlay && overlay.inside && overlay.centred,
   overlay ? `inside ${overlay.inside}, centred ${overlay.centred}` : 'rose or map missing')
/*
 * Reported from the field: "the black circle behind the bearing read out
 * needs to be gone to view the map better". There were two discs — the dial's
 * face and the hub the digits sat on — and both covered ground. Checked by
 * counting filled circles inside the dial rather than by looking at one of
 * them, so putting either back goes red.
 */
const solidDiscs = await page.evaluate(() => {
  const rose = document.querySelector('svg[viewBox="-100 -100 200 200"]')
  if (!rose) return -1
  return [...rose.querySelectorAll('circle')].filter((c) => {
    const f = c.getAttribute('fill')
    const r = parseFloat(c.getAttribute('r') ?? '0')
    return r > 20 && f && f !== 'none' && !/rgba\(.*0(\.\d+)?\)/.test(f)
  }).length
})
ok('no disc behind the dial or its digits — the ground shows through',
   solidDiscs === 0, `${solidDiscs} filled disc(s) of r > 20`)

/*
 * Reported from a phone: the 38 px bearing sat in the middle of the dial, on
 * top of the crew's own position marker and the nought of the range scale.
 * It belongs under the map. Checked by geometry — the readout must be BELOW
 * the map box — because "it exists" was true before and after.
 */
const readoutPlace = await page.evaluate(() => {
  const box = document.querySelector('div.touch-none')
  const out = document.querySelector('[data-heading]')
  if (!box || !out) return null
  const b = box.getBoundingClientRect()
  const r = out.getBoundingClientRect()
  return { below: r.top >= b.bottom - 1, insideSvg: !!out.closest('svg'), text: (out.textContent ?? '').trim() }
})
ok('the bearing is read out below the dial, not on top of the crew',
   !!readoutPlace && readoutPlace.below && !readoutPlace.insideSvg,
   readoutPlace ? `"${readoutPlace.text}" below=${readoutPlace.below} inSvg=${readoutPlace.insideSvg}` : 'no readout')
ok('while the map under it still takes a gesture',
   await page.evaluate(() => {
     const layer = document.querySelector('div.touch-none .pointer-events-none.absolute.inset-0')
     return !!layer
   }))

/*
 * The range scale is a ruler along the way the crew is facing, not rings:
 * one line of ground covered instead of three circles of it. Checked as
 * "graduations on a line", which rings cannot satisfy.
 */
const scale = await page.evaluate(() => {
  const svg = document.querySelector('div.touch-none svg')
  if (!svg) return null
  const dashed = [...svg.querySelectorAll('circle')].filter(
    (c) => c.getAttribute('stroke-dasharray') && c.getAttribute('fill') === 'none',
  ).length
  return {
    ringCircles: dashed,
    arrowHeads: svg.querySelectorAll('polygon').length,
  }
})
/*
 * And the scale has to reach the edge. It stopped at 750 ft in the middle of
 * the photograph, because its length was half the smaller side of the map
 * rather than the distance to the edge along the way the crew is facing.
 */
/*
 * Measured with the boat pushed AWAY from the middle, because centred on this
 * map half the smaller side happens to equal the distance to the top edge —
 * so the check passed against the old formula too. Panning down separates
 * them: the room ahead grows, and a ruler that reaches the edge grows with
 * it while one fixed at half the map does not.
 */
const reachBox = await page.locator('div.touch-none').first().boundingBox()
await page.mouse.move(reachBox.x + reachBox.width / 2, reachBox.y + reachBox.height / 2)
await page.mouse.down()
await page.mouse.move(reachBox.x + reachBox.width / 2, reachBox.y + reachBox.height / 2 + 90, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(600)

const reach = await page.evaluate(() => {
  const box = document.querySelector('div.touch-none')
  const svg = box ? box.querySelector('svg') : null
  if (!box || !svg) return null
  const b = box.getBoundingClientRect()
  const head = svg.querySelector('polygon.fill-white')
  if (!head) return null
  const h = head.getBoundingClientRect()
  const dot = svg.querySelector('circle.fill-emerald-400')
  const d = dot ? dot.getBoundingClientRect() : null
  return {
    gapToTop: Math.round(h.top - b.top),
    boatToTop: d ? Math.round(d.top - b.top) : null,
    height: Math.round(b.height),
  }
})
ok('the scale runs to the edge of the map, not to half of it',
   !!reach && reach.gapToTop <= 26 && (reach.boatToTop ?? 0) - reach.gapToTop > 200,
   reach ? `arrow ${reach.gapToTop}px from the top, boat ${reach.boatToTop}px down, box ${reach.height}px` : 'no arrow')

// Back to following, so what comes next starts where it expects to.
await page.getByRole('button', { name: /Centre on my position/i }).click()
await page.waitForTimeout(600)

ok('the range scale is a ruler ahead, not rings around',
   !!scale && scale.ringCircles === 0 && scale.arrowHeads > 0,
   scale ? `${scale.ringCircles} dashed circles, ${scale.arrowHeads} arrow head(s)` : 'no map svg')

/*
 * "The map and the compass is just slightly off." They were: the dial kept
 * whatever reference the crew picked while the ground turned by true, so the
 * two Norths sat a declination apart. One screen, one north — the dial reads
 * true whenever there is ground under it, and the caption has to say so.
 */
const dialCaption = await page.evaluate(() => {
  // Anywhere, not inside the dial: the caption follows the bearing readout,
  // which moved below the map when it was found to be covering the crew.
  const el = document.querySelector('[data-caption]')
  return el ? (el.textContent ?? '').trim() : null
})
ok('the dial reads true while the map is under it, so the two agree',
   /TRUE/i.test(dialCaption ?? ''), dialCaption ?? 'no caption')
ok('and the reference toggle is gone rather than left inert',
   await page.getByRole('radio', { name: /^Magnetic$/i }).count() === 0)

/* The control a crew reaches for after panning has to be on top of the dial. */
const centreOnTop = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /Centre on my position/i.test(b.getAttribute('aria-label') ?? ''))
  if (!btn) return null
  const stack = btn.parentElement
  const rose = document.querySelector('svg[viewBox="-100 -100 200 200"]')
  const overlay = rose ? rose.closest('div.z-10') : null
  const zStack = stack ? Number(getComputedStyle(stack).zIndex) || 0 : 0
  const zOverlay = overlay ? Number(getComputedStyle(overlay).zIndex) || 0 : 0
  return { zStack, zOverlay, visible: !!btn.offsetParent }
})
ok('centre-on-me sits above the dial, where it can be found and pressed',
   !!centreOnTop && centreOnTop.visible && centreOnTop.zStack > centreOnTop.zOverlay,
   centreOnTop ? `control z${centreOnTop.zStack} over dial z${centreOnTop.zOverlay}` : 'no button')

ok('a north arrow says which way north went',
   await page.locator('svg text').filter({ hasText: /^N$/ }).count() > 0)

// Range rings, and the distances written on them.
const ringLabels = await page.evaluate(() =>
  [...document.querySelectorAll('svg text')]
    .map((t) => t.textContent ?? '')
    .filter((t) => /^[\d.]+ (NM|km|mi|ft|m)$/.test(t)))
ok('the scale is graduated with distances on it', ringLabels.length >= 4,
   ringLabels.slice(0, 5).join(', '))
ok('and it reads 0, s, 2s, 3s from the boat outwards',
   (() => {
     /*
      * The map's own scale bar shares this label format, so only graduations
      * whose unit appears four times are compared — nought at the boat and
      * three steps out. The first version of this check counted three and
      * went red the moment the ruler gained its nought, which is the label
      * that makes it a ruler rather than a set of rings.
      */
     const unit = (t) => t.split(' ')[1]
     const graduations = ringLabels.filter(
       (t, _i, a) => a.filter((x) => unit(x) === unit(t)).length >= 4,
     )
     const v = graduations.map((t) => parseFloat(t)).filter(Number.isFinite).sort((a, b) => a - b)
     return v.length >= 4 && v[0] === 0
       && Math.abs(v[2] - v[1] * 2) < 1e-6 && Math.abs(v[3] - v[1] * 3) < 1e-6
   })(),
   ringLabels.join(' / '))

/*
 * The gesture check, and the reason the frame transforms exist: with the map
 * turned 200°, dragging DOWN the screen must move the ground down the screen
 * — not off at 200° to it. Read as the position under the middle of the map
 * before and after.
 */
/** Where the boat is drawn, in screen pixels — transforms and all. */
const boatAt = async () => await page.evaluate(() => {
  const box = document.querySelector('div.touch-none')
  const dot = box ? box.querySelector('circle.fill-emerald-400') : null
  if (!dot) return null
  const r = dot.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
const boatBefore = await boatAt()
const box = await page.locator('div.touch-none').first().boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(600)
const boatAfter = await boatAt()
/*
 * The check the frame transforms exist for. Drag 80 px straight down on a map
 * turned 174° and the ground — the boat with it — must come 80 px straight
 * down the screen. Without turning the delta into the map's own frame it
 * leaves at 174° to the finger instead, which is the bug that would have
 * shipped: a map that pans sideways when you drag down.
 */
ok('dragging a turned map moves it the way the finger went',
   !!boatBefore && !!boatAfter
     && Math.abs(boatAfter.y - boatBefore.y - 80) <= 12
     && Math.abs(boatAfter.x - boatBefore.x) <= 12,
   boatBefore && boatAfter
     ? `boat moved ${boatAfter.x - boatBefore.x}, ${boatAfter.y - boatBefore.y} px for a drag of 0, 80`
     : 'boat not drawn')

// North up is one tap away, and really is north up.
await page.getByRole('radio', { name: /^North up$/ }).click()
await page.waitForTimeout(700)
ok('north up puts the ground back where a printed chart has it',
   near(await groundDeg(), 0), `${await groundDeg()}°`)

ok('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
server.close()

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
