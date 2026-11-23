import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { captureInstallPrompt } from './lib/install'
import { isNativeApp } from './lib/native'

// Before render: Chrome fires this once, early, and does not fire it again.
captureInstallPrompt()

// The website works offline through a service worker. The Android app already
// has every file on the phone, and a worker there would only serve stale
// screens after an update, so it is registered on the web alone.
if (!isNativeApp()) {
  void import('virtual:pwa-register').then(({ registerSW }) =>
    registerSW({ immediate: true }),
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
