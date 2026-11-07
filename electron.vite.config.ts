import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { serwist } from '@serwist/vite'
import { loadEnv, type Plugin } from 'vite'
import { rendererManualChunk } from './scripts/renderer-manual-chunk'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const DEFAULT_ONEDRIVE_CLIENT_ID = '2aeb121a-c658-4766-ad71-d31625db10bd'
const DEFAULT_BIBLE_API_HOST = 'https://www.alive.org.tw'
const DEFAULT_BIBLE_API_V1_PREFIX = '/api/bible/v1'
const DEFAULT_BIBLE_API_V2_PREFIX = '/api/bible/v2'
const DEFAULT_HHC_ACCOUNT_ORIGIN = 'https://account.alive.org.tw'
const DEFAULT_HHC_ASSET_ORIGIN = 'https://www.alive.org.tw'

function cleanPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') || '/' : fallback
}

function cleanHttpOrigin(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback
  try {
    const url = new URL(candidate)
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    ) {
      return url.origin
    }
  } catch {
    // Fall back to the production Account origin for invalid build input.
  }
  return fallback
}

function createBuildConfig(mode: string): {
  bibleApiHost: string
  hhcAccountOrigin: string
  hhcAssetOrigin: string
  defines: Record<string, string>
} {
  const env = loadEnv(mode, process.cwd(), '')
  const clientId = env.VITE_ONEDRIVE_CLIENT_ID?.trim()
  const oneDriveClientId =
    clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
      ? clientId
      : DEFAULT_ONEDRIVE_CLIENT_ID
  const bibleApiHost = env.VITE_BIBLE_API_HOST?.trim() || DEFAULT_BIBLE_API_HOST
  const hhcAccountOrigin = cleanHttpOrigin(env.VITE_HHC_ACCOUNT_ORIGIN, DEFAULT_HHC_ACCOUNT_ORIGIN)
  const hhcAssetOrigin = cleanHttpOrigin(env.VITE_HHC_ASSET_ORIGIN, DEFAULT_HHC_ASSET_ORIGIN)

  return {
    bibleApiHost,
    hhcAccountOrigin,
    hhcAssetOrigin,
    defines: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __ONEDRIVE_CLIENT_ID__: JSON.stringify(oneDriveClientId),
      __HHC_ACCOUNT_ORIGIN__: JSON.stringify(hhcAccountOrigin),
      __HHC_ASSET_ORIGIN__: JSON.stringify(hhcAssetOrigin),
      __BIBLE_API_HOST__: JSON.stringify(bibleApiHost),
      __BIBLE_API_V1_PREFIX__: JSON.stringify(
        cleanPath(env.VITE_BIBLE_API_V1_PREFIX, DEFAULT_BIBLE_API_V1_PREFIX)
      ),
      __BIBLE_API_V2_PREFIX__: JSON.stringify(
        cleanPath(env.VITE_BIBLE_API_V2_PREFIX, DEFAULT_BIBLE_API_V2_PREFIX)
      )
    }
  }
}

function configuredOriginsCsp(accountOrigin: string, assetOrigin: string): Plugin {
  return {
    name: 'configured-origins-csp',
    transformIndexHtml(html) {
      return html
        .replaceAll('__HHC_ACCOUNT_ORIGIN__', accountOrigin)
        .replaceAll('__HHC_ASSET_ORIGIN__', assetOrigin)
    }
  }
}

function devCspUnsafeInline(): Plugin {
  return {
    name: 'dev-csp-unsafe-inline',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    }
  }
}

function hostedWebBase(mode: string): Plugin {
  return {
    name: 'hosted-web-base',
    enforce: 'post',
    config: () => (mode === 'web' ? { base: '/' } : undefined)
  }
}

export default defineConfig(({ mode }) => {
  const buildConfig = createBuildConfig(mode)

  return {
    main: {
      define: buildConfig.defines,
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      }
    },
    preload: {
      define: buildConfig.defines,
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      }
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      define: buildConfig.defines,
      worker: {
        format: 'es'
      },
      optimizeDeps: {
        include: ['pdfjs-dist', 'pdfjs-dist/build/pdf.worker.mjs']
      },
      plugins: [
        hostedWebBase(mode),
        react(),
        tailwindcss(),
        configuredOriginsCsp(buildConfig.hhcAccountOrigin, buildConfig.hhcAssetOrigin),
        devCspUnsafeInline(),
        serwist({
          swSrc: resolve('src/renderer/src/service-worker.ts'),
          swDest: 'sw.js',
          globDirectory: resolve('out/renderer'),
          rollupFormat: 'iife',
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
          globIgnores: [
            '**/lyrics-runtime/**',
            '**/assets/ChineseSpeechPilot-*.js',
            '**/assets/pdf-*.js',
            '**/assets/pdf.worker-*.js',
            '**/assets/transformers*.js',
            '**/assets/microsoft.cognitiveservices.speech.sdk-*.js',
            '**/assets/aiden0z-pptx-renderer*.js',
            '**/assets/hhc-asset-api-*.js',
            '**/assets/hhc-line-access-*.js',
            '**/assets/hhc-line-connect-*.js'
          ]
        }),
        visualizer({
          filename: 'bundle-report.html',
          open: false,
          gzipSize: true,
          brotliSize: true
        }) as unknown as Plugin
      ],
      server: {
        proxy: {
          '/api/bible': {
            target: buildConfig.bibleApiHost,
            changeOrigin: true,
            secure: true
          }
        }
      },
      build: {
        minify: 'esbuild',
        rollupOptions: {
          output: {
            manualChunks: rendererManualChunk
          }
        }
      }
    }
  }
})
