import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The service worker keeps an offline copy (about 6 MB, downloaded after the page has loaded) and measures
// uploads. Skipped when the browser asks to save data.
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
if (import.meta.env.PROD && 'serviceWorker' in navigator && !saveData) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
