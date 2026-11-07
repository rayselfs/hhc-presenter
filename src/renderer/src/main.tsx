import './assets/main.css'
import '@renderer/i18n'
import { suppressBenignTransitionAbortErrors } from '@renderer/lib/suppress-benign-rejections'

suppressBenignTransitionAbortErrors()

if (import.meta.env.PROD && /^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed', error)
    })
  })
}

if (window.location.pathname === '/oauth/callback') {
  void import('./auth-callback-entry')
} else if (window.location.hash.startsWith('#/projection')) {
  void import('./projection-entry')
} else {
  void import('./control-entry')
}
