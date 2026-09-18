import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Presenter auth boundary', () => {
  it('delegates browser authentication protocol to account-client', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'src/renderer/src/lib/hhc-auth-browser.ts'),
      'utf8'
    )

    expect(source).toContain("from '@hallelujahhomechurch/account-client'")
    expect(source).not.toMatch(/\/(?:session\/access-token|refresh|oauth\/token)/)
  })
})
