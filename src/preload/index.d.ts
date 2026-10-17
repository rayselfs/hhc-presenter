import type { PresenterApi } from '../shared/presenter-api'

declare global {
  interface Window {
    api: PresenterApi
  }
}
