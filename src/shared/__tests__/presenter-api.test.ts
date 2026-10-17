import { expectTypeOf, it } from 'vitest'
import type { PresenterApi } from '../presenter-api'
import type { IpcInvokeMap } from '../ipc-channels'

it('rejects incomplete public bridge implementations', () => {
  expectTypeOf<Omit<PresenterApi, 'projection'>>().not.toExtend<PresenterApi>()
  expectTypeOf<() => Promise<string>>().not.toExtend<PresenterApi['projection']['check']>()
  expectTypeOf<PresenterApi['bible']['getContent']>().parameters.toEqualTypeOf<
    IpcInvokeMap['bible:get-content']['args']
  >()
  expectTypeOf<PresenterApi['bible']['getContent']>().returns.toEqualTypeOf<
    Promise<IpcInvokeMap['bible:get-content']['result']>
  >()
})

it('keeps the File-facing import separate from the wire representation', () => {
  expectTypeOf<PresenterApi['nativeFs']['importFile']>().parameters.toEqualTypeOf<
    [id: string, file: File]
  >()
  expectTypeOf<PresenterApi['nativeFs']['importFile']>().not.toExtend<
    (...args: IpcInvokeMap['native-fs:import-file']['args']) => Promise<{ size: number }>
  >()
})
