import { StrictMode } from 'react'
import { MediaImportStatus } from '@renderer/components/Control/FileExplorer/MediaImportStatus'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@renderer/contexts/ThemeContext'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { RouterProvider } from 'react-router-dom'
import { router } from '@renderer/router'
import { Toast } from '@heroui/react/toast'
import { startEarlyInit, prefetchRouteChunks } from '@renderer/lib/app-init'
import { HhcAuthProvider } from '@renderer/contexts/HhcAuthContext'

startEarlyInit()
prefetchRouteChunks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <HhcAuthProvider>
          <Toast.Provider placement="bottom end" />
          <MediaImportStatus />
          <RouterProvider router={router} />
        </HhcAuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
)
