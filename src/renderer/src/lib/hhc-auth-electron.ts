import type { HhcAuthAdapter, HhcPendingSignIn, HhcSession } from '@shared/hhc-auth'

export class ElectronHhcAuthAdapter implements HhcAuthAdapter {
  private readonly cleanups = new Set<() => void>()
  private signInGeneration = 0
  private ownsPendingSignIn = false

  getSession(): Promise<HhcSession | null> {
    return window.api.hhcAuth.getSession()
  }

  async signIn(): Promise<HhcPendingSignIn> {
    const generation = ++this.signInGeneration
    this.ownsPendingSignIn = true
    try {
      return await window.api.hhcAuth.begin()
    } catch (error) {
      if (this.signInGeneration === generation) this.ownsPendingSignIn = false
      throw error
    }
  }

  cancelSignIn(): Promise<void> {
    if (!this.ownsPendingSignIn) return Promise.resolve()
    this.signInGeneration += 1
    this.ownsPendingSignIn = false
    return window.api.hhcAuth.cancel()
  }

  getAccessToken(): Promise<string | null> {
    return window.api.hhcAuth.getAccessToken()
  }

  refreshAfterUnauthorized(rejectedToken: string): Promise<string | null> {
    return window.api.hhcAuth.refreshAfterUnauthorized(rejectedToken)
  }

  signOut(): Promise<void> {
    this.signInGeneration += 1
    this.ownsPendingSignIn = false
    return window.api.hhcAuth.signOut()
  }

  subscribe(listener: (session: HhcSession | null) => void): () => void {
    const cleanup = window.api.hhcAuth.onSessionChanged((session) => {
      if (session) {
        this.signInGeneration += 1
        this.ownsPendingSignIn = false
      }
      listener(session)
    })
    let active = true
    const unsubscribe = (): void => {
      if (!active) return
      active = false
      this.cleanups.delete(unsubscribe)
      cleanup()
    }
    this.cleanups.add(unsubscribe)
    return unsubscribe
  }

  dispose(): void {
    if (this.ownsPendingSignIn) void this.cancelSignIn().catch(() => undefined)
    for (const unsubscribe of [...this.cleanups]) unsubscribe()
  }
}

export function createElectronHhcAuthAdapter(): ElectronHhcAuthAdapter {
  return new ElectronHhcAuthAdapter()
}
