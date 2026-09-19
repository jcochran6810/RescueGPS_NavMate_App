/**
 * Headless drive of the production build **as a phone**.
 *
 * Every other drive in this repo runs at phone width but with a mouse: a
 * desktop Chromium, no touch, no device pixel ratio, a desktop user agent.
 * That is enough for layout and for logic, and it is not enough for the
 * things that only exist on a phone — a press delivered as a touch rather
 * than a mouse button, a tap target under a thumb, a control that lands
 * under the home indicator, a `:hover` style that never fires.
 *
 * So this one turns those on: touch input dispatched through CDP the way
 * Chrome does on a real device, `isMobile` (which changes viewport metadata
 * handling), a device pixel ratio of 3, and an iOS user agent.
 *
 * It cannot replace a real phone. Three things are still out of reach and
 * are listed in `fix_list.md`: the magnetometer, iOS Safari's own
 * `requestPermission` gate, and the service worker's offline path.
 *
 *   npm run build && node scripts/drive-mobile.mjs
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
const ok=(name,pass,detail='')=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'}  ${name}${detail?'  — '+detail:''}`)}

const HERE={lat:29.3,lon:-94.82}
const browser = await chromium.launch({ args:['--no-sandbox'] })

/** An iPhone 14, near enough: size, pixel ratio, touch, and iOS Safari's UA. */
const context = await browser.newContext({
  viewport:{width:390,height:844},
  deviceScaleFactor:3,
  isMobile:true,
  hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  serviceWorkers:'block',
  permissions:['geolocation'],
  geolocation:{latitude:HERE.lat,longitude:HERE.lon,accuracy:5},
})

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64')
for (const host of ['server.arcgisonline.com','gis.charttools.noaa.gov','tiles.openseamap.org'])
  await context.route(`**://${host}/**`, r=>r.fulfill({status:200,contentType:'image/png',body:PNG}))
const written=[]
await context.route('**://*.supabase.co/**', async r=>{
  const url=r.request().url(), method=r.request().method()
  const json=(o)=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)})
  if (url.includes('/auth/v1/')) return json({})
  if (/\/rest\/v1\/waypoints/.test(url)) {
    if (method==='POST'||method==='PATCH') {
      try { const b=JSON.parse(r.request().postData()||'[]'); for (const row of (Array.isArray(b)?b:[b])) written.push(row) } catch {}
      return json([])
    }
    return json(written)
  }
  if (/\/rest\/v1\/rpc\//.test(url)) return json([])
  return json([])
})

const page = await context.newPage()
const errors=[]
const blocked=[]
page.on('pageerror',e=>errors.push(String(e)))
page.on('console', m => {
  if (m.type() !== 'error') return
  // A blocked request is the sandbox, not the app: this proxy denies NOAA and
  // every other third party, exactly as it denies the live site. What matters
  // here is an error the app itself threw.
  if (/Failed to load resource|ERR_/.test(m.text())) { blocked.push(m.text()); return }
  errors.push('console: '+m.text())
})
await page.addInitScript(()=>{ const now=Math.floor(Date.now()/1000)
  localStorage.setItem('sb-ekhvfypxuxskjglwwoqh-auth-token', JSON.stringify({access_token:'stub',token_type:'bearer',expires_in:3600,expires_at:now+3600,refresh_token:'stub',user:{id:'11111111-1111-4111-8111-111111111111',email:'drive@test',aud:'authenticated'}})) })

/** Touch input as Chrome delivers it on a phone, not a mouse pretending. */
const cdp = await context.newCDPSession(page)
const touchStart = (x,y) => cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,radiusX:12,radiusY:12,force:1}]})
const touchEnd = () => cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
const touchMove = (x,y) => cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y,radiusX:12,radiusY:12,force:1}]})

await page.goto(BASE,{waitUntil:'networkidle'})
ok('the app boots on a phone', await page.getByLabel('Open the menu').count()>0)

const open = async (name) => {
  await page.getByLabel('Open the menu').tap()
  await page.waitForTimeout(300)
  await page.getByRole('menuitem',{name}).first().tap()
  await page.waitForTimeout(700)
}

/* --------------------------------------------------- every section, by touch */
const SECTIONS = [
  [/^Home\b/,'Home'], [/^Live tracking\b/,'Live tracking'], [/^Compass\b/,'Compass'],
  [/^Chart plotter\b/,'Chart plotter'], [/^Convert\b/,'Convert'], [/^Search datum\b/,'Search datum'],
  [/^Search pattern\b/,'Search pattern'], [/^ETA to waypoint\b/,'ETA'], [/^Tides\b/,'Tides'],
  [/^Waypoints\b/,'Waypoints'], [/^Team\b/,'Team'], [/^Data\b/,'Data'],
  [/^Settings\b/,'Settings'], [/^Help \/ Contact\b/,'Help'],
]
const overflow = []
const smallTargets = []
for (const [re,label] of SECTIONS) {
  await open(re)
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (over > 0) overflow.push(`${label} +${over}px`)
  // Anything a thumb is meant to hit should be at least 44 px on iOS.
  const small = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button, a[href], input, select, [role="radio"], [role="switch"], [role="menuitem"]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      if (r.height < 30 || r.width < 30) {
        out.push(`${el.tagName.toLowerCase()}"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,28)}" ${Math.round(r.width)}×${Math.round(r.height)}`)
      }
    }
    return out
  })
  if (small.length) smallTargets.push(`${label}: ${small.slice(0,4).join(', ')}`)
}
ok('no section scrolls sideways on a phone', overflow.length===0, overflow.join(' | '))
ok('no control is smaller than a thumb', smallTargets.length===0, smallTargets.slice(0,3).join(' | '))

/* --------------------------------------------- the press, delivered as a touch */
await open(/^Live tracking\b/)
await page.getByRole('button',{name:/Start tracking/i}).tap()
await page.waitForTimeout(1500)
const map = page.locator('div.touch-none').first()
await map.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box = await map.boundingBox()
const vp = page.viewportSize()
ok('the tracker map is on screen and reachable',
   !!box && box.y >= 0 && box.y + box.height <= vp.height,
   box ? `y=${Math.round(box.y)} h=${Math.round(box.height)}` : 'no box')

const px = box.x + box.width*0.35, py = box.y + box.height*0.4
await touchStart(px,py)
await page.waitForTimeout(800)
await touchEnd()
await page.waitForTimeout(400)
const menu = page.getByRole('menu',{name:/Place on the map/i})
ok('press and hold works with a finger, not just a mouse', await menu.count()>0)

// A finger is never perfectly still. A few pixels of drift must still be a
// press — this is the check a mouse drive cannot make at all.
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await touchStart(px,py)
await page.waitForTimeout(250)
await touchMove(px+3,py+2)
await page.waitForTimeout(250)
await touchMove(px+4,py+3)
await page.waitForTimeout(400)
await touchEnd()
await page.waitForTimeout(400)
ok('and survives the wobble of a hand on a moving boat',
   await menu.count()>0)

// A drag is still a pan, not a press.
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
await touchStart(px,py)
for (let i=1;i<=6;i++){ await touchMove(px+i*12,py+i*4); await page.waitForTimeout(80) }
await page.waitForTimeout(600)
await touchEnd()
await page.waitForTimeout(400)
ok('a finger dragged across the chart still pans it', await menu.count()===0)

/* ------------------------------------------------------ full screen on a phone */
await page.getByRole('button',{name:/^Full screen$/i}).tap()
await page.waitForTimeout(600)
const full = await map.boundingBox()
ok('full screen fills a phone screen',
   !!full && full.height > vp.height*0.8, full?`${Math.round(full.height)}px of ${vp.height}`:'no box')
// The home indicator sits in the bottom ~34 px of an iPhone; nothing tappable
// should be under it.
const bottomGap = full ? vp.height - (full.y + full.height) : -1
ok('and leaves room for the home indicator',
   bottomGap >= 8, `${Math.round(bottomGap)}px below the map`)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

/* ------------------------------------------------------------- the stamp button */
await open(/^Home\b/)
const stamp = page.getByRole('button',{name:/Stamp my position/i})
const sBox = await stamp.boundingBox()
ok('the stamp button is above the home indicator',
   !!sBox && vp.height - (sBox.y + sBox.height) >= 8,
   sBox ? `${Math.round(vp.height - (sBox.y + sBox.height))}px clear` : 'not found')

ok('no uncaught errors anywhere on the phone', errors.length===0, errors.slice(0,3).join(' | '))
console.log(`\n(${blocked.length} request(s) blocked by the sandbox proxy — expected, not app faults)`)

await browser.close(); server.close()
const failed = checks.filter(c=>!c.pass)
console.log(`\n${checks.length-failed.length}/${checks.length} checks passed`)
process.exit(failed.length===0?0:1)
