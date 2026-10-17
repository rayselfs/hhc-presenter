import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import ControlAppShell from '../ControlAppShell'
import routes from '@renderer/router'
import {
  usePresentationSessionRegistry,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'

const routeState: { failWelcome: boolean; registry: PresentationSessionRegistry | null } = {
  failWelcome: false,
  registry: null
}
vi.mock('@renderer/components/Control/Layout', () => ({ default: () => null }))
vi.mock('@renderer/pages/WelcomePage', () => ({
  default: function Welcome() {
    routeState.registry = usePresentationSessionRegistry()
    if (routeState.failWelcome) throw new Error('Welcome failure')
    return <div>Welcome</div>
  }
}))
vi.mock('@renderer/components/RouteError', () => ({
  default: function RouteError() {
    routeState.registry = usePresentationSessionRegistry()
    return <div data-testid="route-error">Route failed</div>
  }
}))

vi.mock('@renderer/lib/env', async (original) => ({
  ...(await original<typeof import('@renderer/lib/env')>()),
  isElectron: () => true
}))

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
})

it('keeps one close responder across Welcome, loading and ready routes in StrictMode', async () => {
  const listeners = new Set<() => void>()
  const confirmClose = vi.fn(async () => ({ closing: true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        onCloseRequested: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        confirmClose
      }
    }
  })
  usePresentationWorkspaceStore.setState({ documents: [] })
  const router = createMemoryRouter(
    [
      {
        element: <ControlAppShell />,
        children: [
          { path: '/welcome', element: <div>Welcome</div> },
          { path: '/loading', element: <div>Loading</div> },
          { path: '/ready', element: <div>Ready</div> }
        ]
      }
    ],
    { initialEntries: ['/welcome'] }
  )
  const rendered = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  )
  for (const [index, route] of ['/welcome', '/loading', '/ready'].entries()) {
    await act(async () => {
      await router.navigate(route)
    })
    expect(listeners.size).toBe(1)
    await act(async () => {
      for (const listener of listeners) listener()
    })
    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(index + 1))
  }
  rendered.unmount()
  expect(listeners.size).toBe(0)
})

it('preserves its registry and close responder through real Welcome and catch-all route errors', async () => {
  const listeners = new Set<() => void>()
  const confirmClose = vi.fn(async () => ({ closing: true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        onCloseRequested: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        confirmClose
      }
    }
  })
  routeState.failWelcome = false
  usePresentationWorkspaceStore.setState({ documents: [] })
  const router = createMemoryRouter(routes, { initialEntries: ['/welcome'] })
  render(<RouterProvider router={router} />)
  const registry = routeState.registry
  expect(registry).not.toBeNull()
  for (const path of ['/missing-route', '/welcome']) {
    routeState.failWelcome = true
    await act(async () => {
      await router.navigate(path)
    })
    expect(await screen.findByTestId('route-error')).toBeInTheDocument()
    expect(routeState.registry).toBe(registry)
    expect(listeners.size).toBe(1)
  }
  await act(async () => {
    for (const listener of listeners) listener()
  })
  await waitFor(() => expect(confirmClose).toHaveBeenCalledOnce())
})
