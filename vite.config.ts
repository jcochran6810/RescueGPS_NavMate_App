import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'emblem-192.png', 'logo.png'],
      manifest: {
        name: 'RescueGPS NavMate',
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
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
