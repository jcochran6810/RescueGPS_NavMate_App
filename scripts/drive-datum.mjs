/**
 * Headless drive of the production build: the Search datum flow — the drift
 * marker's repeating readings and the two moves that follow a datum.
 *
 * Runs offline on purpose (`*.supabase.co` aborted), so records stay in the
 * local queue and cache — which is the state a crew is in when this screen
 * matters most. Service workers blocked, as in the other drives: Playwright
 * route stubs do not intercept SW fetches.
 *
 * It takes about half a minute of wall clock, and that is not padding: a drift
 * reading is a real displacement over real elapsed time, and the app refuses a
 * leg that is too short to measure OR too fast for water to move. Teleporting
 * the boat to save 20 seconds produces 200 kn and tests neither.
 *
 *   npm run build && node scripts/drive-datum.mjs
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
const checks=[]; const ok=(n,p,d='')=>{checks.push(p);console.log(`${p?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`)}

const LAT=29.5, LON=-94.8
const browser = await chromium.launch()
const context = await browser.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block',
  permissions:['geolocation'], geolocation:{latitude:LAT,longitude:LON,accuracy:5} })
// Offline-only: no PostgREST, so records stay in the local queue and cache.
await context.route('**://*.supabase.co/**', r => r.abort())
const page = await context.newPage()
const errors=[]; page.on('pageerror',e=>errors.push(String(e)))
await page.addInitScript(()=>{ const now=Math.floor(Date.now()/1000)
  localStorage.setItem('sb-ekhvfypxuxskjglwwoqh-auth-token', JSON.stringify({access_token:'stub',token_type:'bearer',expires_in:3600,expires_at:now+3600,refresh_token:'stub',user:{id:'11111111-1111-4111-8111-111111111111',email:'drive@test',aud:'authenticated'}})) })
await page.goto(BASE,{waitUntil:'networkidle'})

const openTab = async (name) => {
  await page.getByLabel('Open the menu').click(); await page.waitForTimeout(250)
  await page.getByRole('menuitem',{name}).first().click(); await page.waitForTimeout(600)
}
await openTab(/Search datum/i)
ok('Search datum opens', await page.getByRole('heading',{name:/Search datum/i}).count()>0)

// --- LKP so the worksheet exists -------------------------------------------
await page.getByRole('button',{name:/Use my position/i}).first().click()
await page.waitForTimeout(700)
const saveBtn = page.getByRole('button',{name:/save|record/i}).first()
await saveBtn.click()
await page.waitForTimeout(800)

// --- drift marker ------------------------------------------------------------
await page.getByRole('button',{name:'Deploy here'}).click()
await page.waitForTimeout(800)
ok('marker deployed', (await page.getByText(/In the water at/).count())>0)
ok('a 5-minute countdown appears', (await page.getByText(/Next reading in 4:5\d|Next reading in 5:00/).count())>0,
   (await page.getByText(/Next reading in/).first().textContent().catch(()=>'')) ?? '')
ok('Record drift here sits beside Retrieve here',
   (await page.getByRole('button',{name:'Record drift here'}).count())>0 &&
   (await page.getByRole('button',{name:'Retrieve here'}).count())>0)

const t1 = await page.getByText(/Next reading in/).first().textContent()
await page.waitForTimeout(2200)
const t2 = await page.getByText(/Next reading in/).first().textContent()
ok('the countdown counts down', t1!==t2, `${t1} -> ${t2}`)

// Move the boat far enough for a real leg, then record.
await page.waitForTimeout(20000)
await context.setGeolocation({latitude:LAT+0.00045,longitude:LON,accuracy:5})
await page.waitForTimeout(2500)
await page.getByRole('button',{name:'Record drift here'}).click()
await page.waitForTimeout(900)
ok('a reading is recorded and shown', (await page.getByText(/Last reading: set/).count())>0,
   (await page.getByText(/Last reading: set/).first().textContent().catch(()=>''))??'')
const t3 = await page.getByText(/Next reading in/).first().textContent()
ok('the timer resets on a recorded reading', /4:5\d|5:00/.test(t3??''), t3??'')

// A leg inside the noise floor must be refused, not recorded.
await page.waitForTimeout(6000)
await page.getByRole('button',{name:'Record drift here'}).click()
await page.waitForTimeout(1200)
// Asserted on the record, not on the toast: a toast has usually gone by the
// time this runs, and what matters is that nothing was written.
const after = await page.getByText(/Last reading: set/).first().textContent()
ok('a second reading from the same spot is refused, and nothing is recorded',
   /\(1 reading\)/.test(after??''), after??'')

// --- worksheet buttons -------------------------------------------------------
ok('Take me there is offered on the datum',
   (await page.getByRole('button',{name:'Take me there'}).count())>0)
ok('Begin search pattern is NOT offered yet',
   (await page.getByRole('button',{name:'Begin search pattern'}).count())===0)
await page.getByRole('button',{name:'Take me there'}).click()
await page.waitForTimeout(900)
ok('Take me there switches to the chart plotter',
   (await page.getByRole('heading',{name:'Chart plotter'}).count())>0)
ok('and the datum arrived as the destination',
   (await page.getByText(/Datum/).count())>0)

await openTab(/Search datum/i)
ok('Begin search pattern appears after Take me there',
   (await page.getByRole('button',{name:'Begin search pattern'}).count())>0)
await page.getByRole('button',{name:'Begin search pattern'}).click()
await page.waitForTimeout(900)
ok('it opens the search pattern screen',
   (await page.getByText(/Pick a pattern around the datum/i).count())>0)

ok('no uncaught page errors', errors.length===0, errors.slice(0,2).join(' | '))
await browser.close(); server.close()
const pass=checks.filter(Boolean).length
console.log(`\n${pass}/${checks.length} checks passed`)
process.exit(pass===checks.length?0:1)
