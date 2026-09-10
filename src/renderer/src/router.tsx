import { lazy, Suspense } from 'react'
import { createHashRouter, Navigate } from 'react-router-dom'
import Layout from '@renderer/components/Control/Layout'
import RouteError from '@renderer/components/RouteError'
import { isOnboarded } from '@renderer/lib/onboarding'
import WelcomePage from '@renderer/pages/WelcomePage'

const CameraWorkspacePage = lazy(() => import('@renderer/pages/CameraWorkspacePage'))
const TimerPage = lazy(() => import('@renderer/pages/TimerPage'))
const BiblePage = lazy(() => import('@renderer/pages/BiblePage'))
const FilesPage = lazy(() => import('@renderer/pages/FilesPage'))
const MediaWorkspacePage = lazy(() => import('@renderer/pages/MediaWorkspacePage'))
const PresentationWorkspacePage = lazy(() => import('@renderer/pages/PresentationWorkspacePage'))
const FavoritesPage = lazy(() => import('@renderer/pages/FavoritesPage'))
const TrashPage = lazy(() => import('@renderer/pages/TrashPage'))

// eslint-disable-next-line react-refresh/only-export-components
function OnboardingGuard({ children }: { children: React.JSX.Element }): React.JSX.Element {
  if (!isOnboarded()) return <Navigate to="/welcome" replace />
  return children
}

const routes = [
  {
    path: '/',
    element: (
      <OnboardingGuard>
        <Layout />
      </OnboardingGuard>
    ),
    ErrorBoundary: RouteError,
    children: [
      { index: true, element: <Navigate to="/timer" replace /> },
      {
        path: 'timer',
        element: (
          <Suspense fallback={null}>
            <TimerPage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'bible',
        element: (
          <Suspense fallback={null}>
            <BiblePage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'camera',
        element: (
          <Suspense fallback={null}>
            <CameraWorkspacePage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      { path: 'service', element: <Navigate to="/timer" replace /> },
      { path: 'soundboard', element: <Navigate to="/timer" replace /> },
      {
        path: 'cloud-files',
        element: (
          <Suspense fallback={null}>
            <FilesPage mode="personal" />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'shared-files',
        element: (
          <Suspense fallback={null}>
            <FilesPage mode="shared" />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'files',
        element: (
          <Suspense fallback={null}>
            <FilesPage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'media',
        element: (
          <Suspense fallback={null}>
            <MediaWorkspacePage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'presentations/:itemId?',
        element: (
          <Suspense fallback={null}>
            <PresentationWorkspacePage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'favorites',
        element: (
          <Suspense fallback={null}>
            <FavoritesPage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      },
      {
        path: 'trash',
        element: (
          <Suspense fallback={null}>
            <TrashPage />
          </Suspense>
        ),
        ErrorBoundary: RouteError
      }
    ]
  },
  {
    path: '/welcome',
    element: <WelcomePage />
  }
]

export default routes

export const router = createHashRouter(routes)
