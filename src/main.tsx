import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { captureInstallPrompt } from './lib/install'
import { isNativeApp } from './lib/native'
import { UPDATE_CHECK_MS, useUpdate } from './store/useUpdate'

// Before render: Chrome fires this once, early, and does not fire it again.
captureInstallPrompt()

// The website works offline through a service worker. The Android app already
// has every file on the phone, and a worker there would only serve stale
// screens after an update, so it is registered on the web alone.
//
// Either way, a new version is announced, never applied behind the crew's
// back: UpdateBanner offers "Update now" / "Later".
if (!isNativeApp()) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh: () => useUpdate.getState().webReady(() => updateSW(true)),
      // The browser only looks for a new service worker on navigation; an app
      // left open on a boat all day would never hear of one without this.
      onRegisteredSW: (_url, registration) => {
        if (!registration) return
        // A version downloaded earlier and put off with "Later" is still
        // waiting when the app is next opened — offer it again.
        if (registration.waiting && navigator.serviceWorker.controller) {
          useUpdate.getState().webReady(() => updateSW(true))
        }
        const look = () => void registration.update().catch(() => {})
        setInterval(look, UPDATE_CHECK_MS)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') look()
        })
      },
    })
  })
} else {
  const check = () => void useUpdate.getState().checkNative()
  check()
  setInterval(check, UPDATE_CHECK_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
