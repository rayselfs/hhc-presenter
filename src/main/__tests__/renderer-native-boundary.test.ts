import { ESLint, type Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()
const filePath = 'src/renderer/src/lib/native-boundary-fixture.ts'

async function boundaryMessages(source: string, path = filePath): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(source, { filePath: path })
  return result.messages.filter(
    (message) => message.ruleId === '@typescript-eslint/no-restricted-imports'
  )
}

describe('renderer native import boundary', () => {
  it.each([
    "import * as native from 'electron'",
    "import { ipcRenderer as ipc } from 'electron'",
    "import {\n readFile\n} from 'node:fs/promises'",
    "import fs from 'fs'",
    "export { app } from 'electron'",
    "import { api } from '../../../preload/index'",
    "import { api } from '../../../preload'",
    "import '../../../main'",
    "import { native } from '@main/ipc/native-fs'"
  ])('rejects runtime imports: %s', async (source) => {
    expect(await boundaryMessages(source)).toHaveLength(1)
  })

  it.each([
    "import type { IpcRenderer } from 'electron'",
    "import { type IpcRenderer } from 'electron'",
    "import { createProjectionAdapter } from '@renderer/lib/projection-adapter'",
    'const api = window.api',
    "import { TIMER_DEFAULTS } from '@shared/constants/timer'",
    "const load = () => import('@renderer/lib/projection-adapter')"
  ])('allows renderer contracts: %s', async (source) => {
    expect(await boundaryMessages(source)).toEqual([])
  })

  it('allows Node capabilities in tests and main process', async () => {
    const source = "import { readFile } from 'node:fs/promises'"
    expect(await boundaryMessages(source, 'src/renderer/src/lib/example.test.ts')).toEqual([])
    expect(await boundaryMessages(source, 'src/main/example.ts')).toEqual([])
  })
})
