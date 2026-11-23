import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { captureInstallPrompt } from './lib/install'

// Before render: Chrome fires this once, early, and does not fire it again.
captureInstallPrompt()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
