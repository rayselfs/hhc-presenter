import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createPersistName, hhcPersistStorage } from '@renderer/lib/persist-storage'
import type { PersonalQuotaExceededData, PersonalUsage } from '@shared/personal-cloud'

type PersonalAccountStatus = 'loading' | 'anonymous' | 'authenticated' | 'unavailable'
export type PersonalItemStatus = 'pending' | 'synced' | 'conflict' | 'failed'
interface PersonalSyncState {
  itemStatuses: Record<string, PersonalItemStatus>
  lastOwnerId: string | null
  activeOwnerId: string | null
  accountStatus: PersonalAccountStatus
  syncStatus: 'idle' | 'pending' | 'syncing' | 'synced' | 'conflict' | 'auth-required' | 'failed'
  errorCode: string | null
  usage: PersonalUsage | null
  quotaExceeded: PersonalQuotaExceededData | null
  setAccount(status: PersonalAccountStatus, ownerId?: string, allowed?: boolean): void
}

export const usePersonalSyncStore = create<PersonalSyncState>()(
  persist(
    (set) => ({
      itemStatuses: {},
      lastOwnerId: null,
      activeOwnerId: null,
      accountStatus: 'loading',
      syncStatus: 'idle',
      errorCode: null,
      usage: null,
      quotaExceeded: null,
      setAccount: (status, ownerId, allowed = false) =>
        set((state) => ({
          accountStatus: status,
          activeOwnerId:
            status === 'authenticated'
              ? allowed
                ? (ownerId ?? null)
                : null
              : status === 'unavailable'
                ? state.lastOwnerId
                : null,
          lastOwnerId:
            status === 'authenticated'
              ? allowed
                ? (ownerId ?? null)
                : null
              : status === 'anonymous'
                ? null
                : state.lastOwnerId,
          syncStatus: 'idle',
          errorCode: null,
          usage:
            status === 'unavailable' ||
            (status === 'authenticated' && allowed && ownerId === state.activeOwnerId)
              ? state.usage
              : null,
          quotaExceeded: null,
          itemStatuses: {}
        }))
    }),
    {
      name: createPersistName('personal-sync'),
      storage: hhcPersistStorage,
      version: 1,
      migrate: () => ({ lastOwnerId: null }),
      partialize: (state) => ({ lastOwnerId: state.lastOwnerId })
    }
  )
)

export function isPersonalRecordVisible(record: {
  personalOwnerId?: string
  sharedRecipientId?: string
}): boolean {
  const owner = usePersonalSyncStore.getState().activeOwnerId
  return (
    (!record.personalOwnerId || record.personalOwnerId === owner) &&
    (!record.sharedRecipientId || record.sharedRecipientId === owner)
  )
}
