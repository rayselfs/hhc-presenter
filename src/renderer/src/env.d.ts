/// <reference types="vite/client" />

declare const __APP_VERSION__: string

declare module 'pdfjs-dist/build/pdf.worker.mjs'

declare module '*?url&no-inline' {
  const url: string
  export default url
}
