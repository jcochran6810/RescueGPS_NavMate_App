/**
 * Headless drive of the production build: the search-pattern window, the
 * steering instrument, and the survival banner.
 *
 * Three things here can only be answered in a browser. Whether changing an
 * input actually moves every number that depends on it — the page recomputed
 * its plan but kept the point number it was steering to, which is how "point
 * 9 of 6" appeared. Whether the steering card turns a bearing into an
 * instruction a coxswain can follow without doing arithmetic at the wheel.
 * And whether the survival clock reaches the screens a crew is actually on,
 * rather than the one page they are not looking at.
 *
 * Offline on purpose (`*.supabase.co` aborted): records stay in the local
 * queue and cache, which is the state this screen matters most in.
 *
 *   npm run build && node scripts/drive-search.mjs
 */
const { chromium } = await import('playwright').catch(
  () => import('/opt/node22/lib/node_modules/playwright/index.mjs'),
)
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

const DIST = '/home/user/RescueGPS_NavMate_App/dist'
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json' }
const server = createServer(async (req,res)=>{ let p=join(DIST,decodeURIComponent(req.url.split('?')[0]))
  try{ if((await stat(p)).isDirectory()) p=join(p,'index.html') }catch{ p=join(DIST,'index.html') }
  try{ const b=await readFile(p); res.writeHead(200,{'Content-Type':TYPES[extname(p)]??'application/octet-stream'}); res.end(b) }catch{ res.writeHead(404); res.end('no') } })
await new Promise(r=>server.listen(0,r))
const BASE=`http://127.0.0.1:${server.address().port}`

const checks=[]
const ok=(name,pass,detail='')=>{checks.push({name,pass});console.log(`${pass?'PASS':'FAIL'}  ${name}${detail?'  — '+detail:''}`)}

const LAT=29.5, LON=-94.8
const browser = await chromium.launch({ args:['--no-sandbox'] })
const context = await browser.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block',
  permissions:['geolocation'], geolocation:{latitude:LAT,longitude:LON,accuracy:5} })
await context.route('**://*.supabase.co/**', r => r.abort())
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64')
for (const host of ['server.arcgisonline.com','gis.charttools.noaa.gov','tiles.openseamap.org'])
  await context.route(`**://${host}/**`, r=>r.fulfill({status:200,contentType:'image/png',body:PNG}))

const page = await context.newPage()
const errors=[]; page.on('pageerror',e=>errors.push(String(e)))
await page.addInitScript(()=>{ const now=Math.floor(Date.now()/1000)
  localStorage.setItem('sb-ekhvfypxuxskjglwwoqh-auth-token', JSON.stringify({access_token:'stub',token_type:'bearer',expires_in:3600,expires_at:now+3600,refresh_token:'stub',user:{id:'11111111-1111-4111-8111-111111111111',email:'drive@test',aud:'authenticated'}})) })
await page.goto(BASE,{waitUntil:'networkidle'})

const openTab = async (name) => {
  await page.getByLabel('Open the menu').click(); await page.waitForTimeout(250)
  await page.getByRole('menuitem',{name}).first().click(); await page.waitForTimeout(700)
}

// --- a search with an LKP and conditions on it ------------------------------
await openTab(/^Search datum\b/)
ok('Search datum opens', await page.getByRole('heading',{name:/Search datum/i}).count()>0)

await page.getByRole('button',{name:/Use my (location|position)/i}).first().click()
await page.waitForTimeout(800)
await page.getByRole('button',{name:/^Record LKP$/}).click()
await page.waitForTimeout(700)
ok('an LKP is recorded', (await page.locator('body').innerText()).includes('LKP'))

await page.getByLabel(/Water temperature, Fahrenheit/i).fill('55')
await page.getByRole('button',{name:/^Record conditions$/}).click()
await page.waitForTimeout(700)

/*
 * The banner is the point of this section: it has to be on the screens a crew
 * is actually looking at. Checked on Home, not on the page it was recorded
 * from — a banner that only appeared beside its own inputs would pass a
 * sloppier check and be useless.
 */
const banner = () => page.getByRole('status').filter({ hasText: /Survival window|Past the survival estimate/ })
await openTab(/^Home\b/)
ok('the survival clock is on a page that is not the one it was typed on',
   await banner().count() > 0,
   (await banner().first().textContent() ?? '').trim())
ok('and it says the water temperature it is working from',
   /55\s*°F/.test(await banner().first().textContent() ?? ''),
   (await banner().first().textContent() ?? '').trim())
// Nobody has said there is a life jacket, and the estimate must not assume one.
ok('with the life jacket reported as unknown rather than assumed',
   /PFD unknown/.test(await banner().first().textContent() ?? ''))

const footerBottom = await page.evaluate(() => {
  const el = document.querySelector('.safe-bottom')
  return el ? Math.round(el.getBoundingClientRect().bottom) : -1
})
ok('the footer it sits in is still pinned to the bottom of the screen',
   Math.abs(footerBottom - 844) <= 2, `${footerBottom}px of 844`)
ok('and the stamp button is still reachable under it',
   await page.getByRole('button',{name:/Stamp my position/i}).isVisible())

// --- the pattern window recomputes ------------------------------------------
await openTab(/^Search pattern\b/)
ok('the pattern page opens on the datum',
   (await page.locator('body').innerText()).includes('Search pattern')
   || await page.getByRole('heading',{name:/Search pattern/i}).count()>0)

const bodyText = async () => (await page.locator('body').innerText()).replace(/\s+/g,' ')

const before = await bodyText()
// The Stat cards render their labels upper-cased, so these are matched
// case-insensitively — the first version of this drive looked for "Legs" and
// found nothing, which reads exactly like "the value did not change".
const legsBefore = before.match(/LEGS (\d+)/i)?.[1]
const trackBefore = before.match(/TRACK ([\d.]+)/i)?.[1]
await page.getByLabel(/Track spacing in nautical miles/i).fill('0.2')
await page.waitForTimeout(600)
const after = await bodyText()
const legsAfter = after.match(/LEGS (\d+)/i)?.[1]
const trackAfter = after.match(/TRACK ([\d.]+)/i)?.[1]
ok('changing the spacing changes the plan',
   !!legsBefore && !!legsAfter && (legsBefore !== legsAfter || trackBefore !== trackAfter),
   `${legsBefore} legs/${trackBefore} NM → ${legsAfter} legs/${trackAfter} NM`)

const podBefore = after.match(/POD (\d+) %/)?.[1]
await page.getByLabel(/Track spacing in nautical miles/i).fill('0.05')
await page.waitForTimeout(600)
const podAfter = (await bodyText()).match(/POD (\d+) %/)?.[1]
ok('and the coverage and POD follow it',
   podBefore !== podAfter, `POD ${podBefore} % → ${podAfter} %`)

// Speed drives the time, so the time must move with it.
const timeBefore = (await bodyText()).match(/TIME ([\d.]+ ?\w+)/i)?.[1]?.trim()
await page.getByLabel(/Search speed in knots/i).fill('20')
await page.waitForTimeout(600)
const timeAfter = (await bodyText()).match(/TIME ([\d.]+ ?\w+)/i)?.[1]?.trim()
ok('and the time to run follows the speed',
   !!timeBefore && !!timeAfter && timeBefore !== timeAfter,
   `${timeBefore} → ${timeAfter}`)

// --- steering ----------------------------------------------------------------
await page.getByLabel(/Track spacing in nautical miles/i).fill('0.3')
await page.waitForTimeout(500)
await page.getByRole('button',{name:/Steer (the )?pattern/i}).first().click()
await page.waitForTimeout(800)
ok('steering starts', /STEERING/i.test(await bodyText()))

/*
 * A boat under way. Walked in steps rather than teleported once: the course
 * over ground the card turns from comes out of the tracker's filter, and a
 * filter given one jump has no velocity to report — which is also why the
 * card is right to say nothing in that case.
 */
for (let i = 1; i <= 6; i++) {
  await context.setGeolocation({ latitude: LAT + 0.0004 * i, longitude: LON, accuracy: 5 })
  await page.waitForTimeout(1200)
}
await page.waitForTimeout(1500)

const steerText = await bodyText()
ok('the card says which way to turn, not just what to steer',
   /Come (right|left) \d+°|Steady — on the leg/.test(steerText),
   steerText.match(/Come (right|left) \d+°|Steady — on the leg/)?.[0] ?? 'neither')
ok('and counts down to the turn with a distance',
   /to the turn|Time to run needs/.test(steerText))

/*
 * "Steady" is a real answer but a weak check — it is what the card says when
 * the boat happens to be pointing at the mark. So the boat is turned: walked
 * east for a few fixes, which puts its course over ground across the leg it
 * is supposed to be on, and the card has to name a turn with a side and a
 * number of degrees.
 */
const lonStart = LON
for (let i = 1; i <= 6; i++) {
  await context.setGeolocation({ latitude: LAT + 0.0024, longitude: lonStart + 0.0005 * i, accuracy: 5 })
  await page.waitForTimeout(1200)
}
await page.waitForTimeout(1500)
const turnText = await bodyText()
ok('and once the boat is across the leg it names the turn and its side',
   /Come (right|left) \d+°/.test(turnText),
   turnText.match(/Come (right|left) \d+°/)?.[0] ?? 'no turn named')

await page.getByRole('button',{name:/Show all upcoming turns/i}).click()
await page.waitForTimeout(400)
const rows = await page.locator('table tbody tr').count()
ok('every upcoming turn can be listed', rows > 1, `${rows} rows`)
ok('the table names the one being steered to now',
   /next/.test(await page.locator('table').first().innerText()))
await page.getByRole('button',{name:/Hide upcoming turns/i}).click()
await page.waitForTimeout(300)

/*
 * The bug this exists for: re-plan while steering and the point number stayed
 * where it was, counting to a point the new plan does not have.
 */
const pointLabel = async () =>
  (await bodyText()).match(/Point (\d+) of (\d+)/)?.slice(1).join(' of ') ?? ''
await page.getByRole('button',{name:/Skip to next/i}).click()
await page.waitForTimeout(400)
await page.getByRole('button',{name:/Skip to next/i}).click()
await page.waitForTimeout(400)
const movedOn = await pointLabel()
/*
 * A different pattern, not a different spacing. Spacing is clamped into a leg
 * count, so two spacings can legitimately produce the same shape — and a
 * check that cannot tell "the plan did not change" from "the steering did not
 * follow it" is testing nothing. Switching the pattern type always changes
 * the shape.
 */
await page.getByRole('button',{name:/Parallel track/i}).first().click()
await page.waitForTimeout(900)
const afterReplan = await pointLabel()
const [ptNow, ptOf] = afterReplan.split(' of ').map(Number)
ok('re-planning the pattern restarts the steering on the new plan',
   afterReplan !== movedOn && ptNow === 1,
   `${movedOn} → ${afterReplan}`)
ok('and never counts to a point the plan does not have',
   Number.isFinite(ptNow) && Number.isFinite(ptOf) && ptNow <= ptOf,
   afterReplan)

ok('no uncaught page errors', errors.length===0, errors.slice(0,2).join(' | '))

await browser.close(); server.close()
const failed = checks.filter(c=>!c.pass)
console.log(`\n${checks.length-failed.length}/${checks.length} checks passed`)
process.exit(failed.length===0?0:1)
