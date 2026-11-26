import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import type { Plugin } from 'vite'
import { ENC_QUERY_RULE } from './src/lib/encCache'

/**
 * Which build this is. Vercel and GitHub Actions both name the commit they
 * build, so the website and the Android APK made from the same push of main
 * carry the same id — that is what lets the app tell "a newer version is out".
 */
function buildSha(): string {
  const fromCi = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA
  if (fromCi) return fromCi
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}
const BUILD = {
  sha: buildSha(),
  builtAt: new Date().toISOString(),
  // Set by the Android workflow (the run number); the website has none.
  version: process.env.NAVMATE_VERSION_CODE
    ? `1.0.${process.env.NAVMATE_VERSION_CODE}`
    : null,
}

/** Publishes /version.json — the live build's id, read by every copy of the app. */
function versionFile(): Plugin {
  return {
    name: 'navmate-version-file',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ sha: BUILD.sha, builtAt: BUILD.builtAt }),
      })
    },
  }
}

export default defineConfig({
  define: {
    __APP_SHA__: JSON.stringify(BUILD.sha),
    __APP_BUILT_AT__: JSON.stringify(BUILD.builtAt),
    __APP_VERSION__: JSON.stringify(BUILD.version),
  },
  plugins: [
    versionFile(),
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt': a new version waits for the crew's "Update now" rather
      // than reloading the page under them mid-task (UpdateBanner).
      registerType: 'prompt',
      // Registered from main.tsx instead, so the Android app (which carries
      // its own copy of the build) can skip the service worker entirely.
      injectRegister: false,
      // No icon-512 here: includeAssets adds to the precache manifest, which
      // silently re-added the file the globIgnores below exists to keep out.
      includeAssets: ['icon-192.png', 'emblem-192.png', 'logo.png'],
      manifest: {
        name: 'NavMate',
        short_name: 'NavMate',
        description:
          'Coordinate conversion, live GPS tracking, ETA and shared waypoints for search and rescue teams.',
        // Both the app's own background. The emblem's field is knocked out and
        // composited onto this same colour, so the launcher tile, the install
        // splash, the system bars and the app itself are one continuous shade.
        theme_color: '#06131f',
        background_color: '#06131f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          // Its own file rather than the same one twice: a maskable icon is
          // cropped to whatever shape the launcher wants, so the emblem has to
          // be drawn smaller inside the tile or it loses the tips of its arms.
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The launcher and splash icons are fetched by the operating system at
        // install time, not by the page, so precaching them only inflates what
        // a crew downloads over cellular. The 192 and the logo stay in — those
        // two are rendered by the app itself.
        globIgnores: ['**/icon-512.png', '**/icon-maskable-512.png'],
        // The app shell is cached so the converter, tracker and locally stored
        // waypoints keep working with no signal. Supabase calls are never
        // cached — stale waypoint data in the field is worse than none.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith('.supabase.co'),
            handler: 'NetworkOnly',
          },
          // Satellite imagery. Cache-first because a tile is a photograph of
          // the ground: it does not go stale on the timescale of an incident,
          // and the crew that needs it most is the one with no link left to
          // revalidate it. This cache is also what the map's "Save imagery for
          // offline" button fills — it fetches the tiles around you so they are
          // already here when the signal goes.
          //
          // The host is written out rather than taken from TILE_HOSTS in
          // src/lib/tiles.ts: workbox stringifies this function into the
          // service worker, so anything it closes over would arrive undefined.
          {
            urlPattern: ({ url }) => url.hostname === 'server.arcgisonline.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'navmate-imagery',
              expiration: {
                maxEntries: 2000,
                maxAgeSeconds: 60 * 60 * 24 * 90,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // The route planner's ENC depth/hazard queries, which in a browser
          // all go through the same-origin `/api/enc` relay. See
          // src/lib/encCache.ts — the rule lives there so it can be tested.
          ENC_QUERY_RULE,
          // Nautical chart tiles (and ENC queries made straight to NOAA, which
          // only a non-browser caller does). Their own cache rather than a share of the
          // imagery budget, so a saved operating area cannot evict the chart
          // that goes with it — and a shorter life, because ENC is republished
          // weekly and a month-old wreck position is the wrong kind of stale
          // to steer a rescue boat by. Imagery can sit for 90 days because a
          // photograph of the ground does not move.
          //
          // Hosts are literal for the same reason as above: workbox
          // stringifies this function into the service worker.
          {
            urlPattern: ({ url }) =>
              url.hostname === 'gis.charttools.noaa.gov' ||
              url.hostname === 'encdirect.noaa.gov' ||
              url.hostname === 'tiles.openseamap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'navmate-charts',
              expiration: {
                maxEntries: 1500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
              },
              // 0 accepts opaque responses — neither NOAA host is confirmed to
              // send Access-Control-Allow-Origin, and an opaque tile still
              // draws.
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  // `api/enc.js` only exists once Vercel has deployed it, so `npm run dev`
  // would 404 every chart query and the plotter would look broken locally for
  // a reason that has nothing to do with the code. This is the same relay,
  // done by the dev server.
  server: {
    proxy: {
      '/api/enc': {
        target: 'https://encdirect.noaa.gov',
        changeOrigin: true,
        rewrite: (path: string) => {
          const u = new URL(path, 'http://localhost').searchParams.get('u')
          if (!u) return path
          const target = new URL(u)
          // Same single-host rule as the deployed relay. A dev server that
          // forwarded anywhere would be a hole on the developer's machine.
          if (target.hostname !== 'encdirect.noaa.gov') return path
          return target.pathname + target.search
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
