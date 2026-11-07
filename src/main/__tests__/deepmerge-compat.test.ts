import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type Merge = (target: object, source: object) => Record<string, unknown>

const requireFromAgent = createRequire(require.resolve('global-agent'))
const requireFromRoarr = createRequire(requireFromAgent.resolve('roarr'))

describe.each([
  ['@rollup/plugin-node-resolve', require.resolve('@rollup/plugin-node-resolve')],
  ['fast-json-stringify', requireFromRoarr.resolve('fast-json-stringify')]
])('patched merge used by %s', (_caller, entry) => {
  const merge = createRequire(entry)('deepmerge') as Merge

  it('rejects poison keys in either input, including when the target has no prototype', () => {
    const poison = JSON.parse('{"__proto__":{"isAdmin":true},"nested":{"x":1}}') as object
    for (const value of [merge(poison, {}), merge(Object.create(null), poison)]) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
      expect(value.isAdmin).toBeUndefined()
      expect(Object.hasOwn(value, '__proto__')).toBe(false)
      expect(value.nested).toEqual({ x: 1 })
    }
  })
})
