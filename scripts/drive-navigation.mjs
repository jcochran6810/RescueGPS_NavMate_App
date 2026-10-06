/**
 * Headless drive of the production build: getting around the app.
 *
 * What it proves is the thing the crew asked for in so many words — "the back
 * button needs to navigate to the previous page and the logo needs to act as
 * a home button" — plus the bottom bar and the search steps that replaced the
 * drop-down menu. History is browser behaviour, so none of it can be checked
 * from a unit test: `page.goBack()` is the phone's back button here.
 *
 *   npm run build && node scripts/drive-navigation.mjs
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

const WIDTH = Number(process.env.WIDTH ?? 390)
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 844 },
  serviceWorkers: 'block',
  permissions: ['geolocation'],
  geolocation: { latitude: 29.3, longitude: -94.82, accuracy: 5 },
})
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64')
for (const host of ['server.arcgisonline.com', 'gis.charttools.noaa.gov', 'tiles.openseamap.org']) {
  await context.route(`**://${host}/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
}
await context.route('**://*.supabase.co/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))

const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(() => {
  if (location.protocol === 'about:') return
  const now = Math.floor(Date.now() / 1000)
  localStorage.setItem('sb-ekhvfypxuxskjglwwoqh-auth-token', JSON.stringify({
    access_token: 'stub', token_type: 'bearer', expires_in: 3600,
    expires_at: now + 3600, refresh_token: 'stub',
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'drive@test', aud: 'authenticated' },
  }))
})
// A page opened in a fresh tab has a blank entry behind it; going back to it
// is leaving the app, which is the right answer from Home and is checked.
await page.goto('about:blank')
await page.goto(BASE, { waitUntil: 'networkidle' })

const heading = async () =>
  (await page.locator('main h2:not(.sr-only)').first().textContent().catch(() => ''))?.trim() ?? ''
const onHome = async () => (await page.locator('main h2.sr-only', { hasText: /^Home/ }).count()) > 0
const bar = page.getByRole('navigation', { name: 'Sections' })
const backArrow = page.getByRole('button', { name: 'Back', exact: true })
const settle = () => page.waitForTimeout(350)

ok('app boots on Home', await onHome())
ok('no ← on Home with nothing behind it', (await backArrow.count()) === 0)

// --- bottom bar --------------------------------------------------------------
for (const name of ['Home', 'Chart', 'Search', 'More — open the menu']) {
  ok(`bottom bar has ${name.split(' ')[0]}`, (await bar.getByRole('button', { name }).count()) > 0)
}
ok('the stamp button is the centre of the bar',
   (await bar.getByRole('button', { name: /Stamp my position/ }).count()) > 0)
const barBox = await bar.boundingBox()
ok('the bar sits at the bottom of the screen',
   !!barBox && Math.abs(barBox.y + barBox.height - 844) < 24, JSON.stringify(barBox))

// --- the phone's back button goes to the previous screen ---------------------
await bar.getByRole('button', { name: 'Chart' }).click(); await settle()
ok('Chart opens from the bar', /Chart plotter/.test(await heading()), await heading())
await page.getByRole('button', { name: /^Compass/ }).count() // nothing — compass is in More
await bar.getByRole('button', { name: /More/ }).click(); await settle()
ok('More opens a grid of every section',
   (await page.getByRole('menuitem').count()) >= 15, `${await page.getByRole('menuitem').count()} items`)
await page.getByRole('menuitem', { name: 'Compass' }).click(); await settle()
ok('Compass opens from More', /Compass/.test(await heading()), await heading())
ok('and More closed behind it', (await page.getByRole('menu').count()) === 0)

await page.goBack(); await settle()
ok('phone back: Compass → Chart', /Chart plotter/.test(await heading()), await heading())
await page.goBack(); await settle()
ok('phone back again: Chart → Home', await onHome())

await page.goForward(); await settle()
ok('forward returns to Chart', /Chart plotter/.test(await heading()), await heading())
// Forward again lands on the closed menu's left-over entry, which is stepped
// over rather than left as a screen where nothing happens.
await page.goForward(); await settle()
ok('forward onto a closed menu’s entry is stepped over', /Chart plotter/.test(await heading()), await heading())

// --- the in-app ← does the same ---------------------------------------------
await bar.getByRole('button', { name: 'Home' }).click(); await settle()
await page.getByRole('button', { name: /^Tides/ }).click(); await settle()
ok('Home tool tile opens Tides', /Tides/.test(await heading()), await heading())
ok('← shows once there is somewhere to go back to', (await backArrow.count()) === 1)
await backArrow.click(); await settle()
ok('← returns Home', await onHome())

// --- the logo is the Home button --------------------------------------------
await bar.getByRole('button', { name: 'Chart' }).click(); await settle()
await page.getByRole('button', { name: /NavMate — go to Home/ }).click(); await settle()
ok('tapping the logo goes Home', await onHome())
await page.goBack(); await settle()
ok('and back from there returns to the chart', /Chart plotter/.test(await heading()), await heading())

// --- back closes a sheet before it changes the page --------------------------
await bar.getByRole('button', { name: /More/ }).click(); await settle()
ok('More is open', (await page.getByRole('menu').count()) === 1)
await page.goBack(); await settle()
ok('phone back closes More', (await page.getByRole('menu').count()) === 0)
ok('and leaves the page where it was', /Chart plotter/.test(await heading()), await heading())

await bar.getByRole('button', { name: /Stamp my position/ }).click()
await page.waitForTimeout(900)
const stampSheet = page.getByRole('dialog', { name: /stamped waypoint/i })
ok('stamping opens its sheet', (await stampSheet.count()) === 1)
await page.goBack(); await settle()
ok('phone back closes the stamp sheet', (await stampSheet.count()) === 0)
ok('without leaving the chart', /Chart plotter/.test(await heading()), await heading())
await page.goBack(); await settle()
ok('and the next back press is a real one', await onHome())

// --- the search, as steps ----------------------------------------------------
await page.getByRole('button', { name: /Start a search/ }).click(); await settle()
ok('Start a search opens the Incident step', /Incident/.test(await heading()), await heading())
const steps = page.getByRole('navigation', { name: 'Search steps' })
ok('with the four steps across the top',
   (await steps.getByRole('button').count()) === 4)
await page.getByRole('button', { name: /Next: set the search datum/ }).click(); await settle()
ok('Next goes to the datum', /Search datum/.test(await heading()), await heading())
ok('and the datum page no longer carries the incident cards',
   (await page.getByText(/Start New Search Incident/i).count()) === 0)
await steps.getByRole('button', { name: /Pattern/ }).click(); await settle()
ok('the steps jump to the pattern', /Search pattern/.test(await heading()), await heading())
await steps.getByRole('button', { name: /Clues/ }).click(); await settle()
ok('and to the clue log', /Clue log/.test(await heading()), await heading())
await bar.getByRole('button', { name: 'Home' }).click(); await settle()
await bar.getByRole('button', { name: 'Search' }).click(); await settle()
ok('Search in the bar returns to the step last open', /Clue log/.test(await heading()), await heading())
ok('and is lit while on any search step',
   (await bar.getByRole('button', { name: 'Search' }).getAttribute('aria-current')) === 'page')

// Clues → Home (bar) → Clues (bar): back is the order they were visited.
await page.goBack(); await settle()
ok('back from the bar’s Search returns Home', await onHome())
await page.goBack(); await settle()
await page.goBack(); await settle()
ok('back walks the steps in the order they were visited', /Search pattern/.test(await heading()), await heading())

// --- a reload keeps the screen ----------------------------------------------
await page.reload({ waitUntil: 'networkidle' }); await settle()
ok('a reload stays on the same screen', /Search pattern/.test(await heading()), await heading())
await page.goBack(); await settle()
ok('and back still works after it', /Search datum/.test(await heading()), await heading())

// --- nothing sideways --------------------------------------------------------
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
ok('no sideways scroll', overflow <= 0, `${overflow}px`)

ok('no page errors', errors.length === 0, errors.join(' | '))

await browser.close()
server.close()
const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
