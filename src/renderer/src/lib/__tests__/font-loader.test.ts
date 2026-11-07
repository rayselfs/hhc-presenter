import { vi } from 'vitest'
const font = vi.hoisted(() => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { pending, finish }
})
vi.mock('@fontsource-variable/noto-sans-tc/index.css', async () => {
  await font.pending
  return {}
})
it('waits for the same CSS load when multiple surfaces request a font concurrently', async () => {
  const { loadLanguageFont } = await import('../font-loader')
  let firstReady = false
  let secondReady = false
  const first = loadLanguageFont('zh-TW').then(() => {
    firstReady = true
  })
  const second = loadLanguageFont('zh-TW').then(() => {
    secondReady = true
  })
  await Promise.resolve()
  expect(firstReady).toBe(false)
  expect(secondReady).toBe(false)
  font.finish()
  await Promise.all([first, second])
  expect(firstReady && secondReady).toBe(true)
})
