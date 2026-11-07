/// <reference lib="webworker" />
import { CacheFirst, ExpirationPlugin, NetworkFirst, Serwist, type PrecacheEntry } from 'serwist'
import { OAUTH_CALLBACK_PWA_DENYLIST } from '../../../scripts/pwa-navigation-denylist'

declare const self: ServiceWorkerGlobalScope & { __SW_MANIFEST: PrecacheEntry[] }

new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    // Reuse the existing cache so activation can retire stale entries after an upgrade.
    cacheName: `workbox-precache-v2-${self.registration.scope}`,
    cleanupOutdatedCaches: true,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//, OAUTH_CALLBACK_PWA_DENYLIST]
  },
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      matcher: ({ url }) => url.pathname.startsWith('/lyrics-runtime/'),
      handler: new NetworkFirst({
        cacheName: 'hhc-lyrics-runtime',
        networkTimeoutSeconds: 3,
        plugins: [new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 })]
      })
    },
    {
      matcher: ({ url }) =>
        url.pathname.endsWith('.woff2') ||
        /\/assets\/(pdf(?:\.|-)|transformers(?:\.web)?-|microsoft\.cognitiveservices\.speech\.sdk-)/.test(
          url.pathname
        ) ||
        /\/assets\/aiden0z-pptx-renderer/.test(url.pathname) ||
        /^\/assets\/hhc-(?:asset-api|line-access|line-connect)-[^/]+\.js$/.test(url.pathname),
      handler: new CacheFirst({
        cacheName: 'hhc-optional-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 })]
      })
    }
  ]
}).addEventListeners()
