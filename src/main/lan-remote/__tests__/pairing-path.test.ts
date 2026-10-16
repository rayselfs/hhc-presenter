import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLanRemoteServer } from '../server'

const transport = vi.hoisted(() => ({
  handle: undefined as ((req: IncomingMessage, res: ServerResponse) => void) | undefined
}))
vi.mock('node:http', () => {
  const http = {
    createServer: (handle: typeof transport.handle) => {
      transport.handle = handle
      return {
        once: vi.fn(),
        off: vi.fn(),
        address: () => ({ port: 1234 }),
        listen: (_port: number, _host: string, ready: () => void) => ready(),
        close: (done: () => void) => done()
      }
    }
  }
  return { ...http, default: http }
})
const commandHandler = vi.fn(async () => ({ requestId: 'test', status: 'accepted' as const }))
let server: ReturnType<typeof createLanRemoteServer>
beforeEach(async () => {
  commandHandler.mockClear()
  server = createLanRemoteServer({ commandHandler })
  await server.start({ host: '192.168.1.2', port: 0 })
})
afterEach(async () => {
  await server.stop()
})

function request(url: string): { statusCode: number; end: ReturnType<typeof vi.fn> } {
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
  transport.handle!(
    { method: 'GET', url } as IncomingMessage,
    response as unknown as ServerResponse
  )
  return response
}

it.each(['%', '%GG', '%E0%A4%A'])(
  'rejects malformed pairing path %s without escaping the request handler',
  (path) => {
    let response: ReturnType<typeof request> | undefined
    expect(() => {
      response = request(`/pair/${path}`)
    }).not.toThrow()
    expect(response?.statusCode).toBe(400)
    expect(request('/').statusCode).toBe(200)
    expect(server.getStatus().enabled).toBe(true)
    expect(commandHandler).not.toHaveBeenCalled()
  }
)

it('still accepts a valid encoded secret once and rejects reuse', () => {
  const { secret } = server.createPairingSecret('Phone')
  const encoded = `%${secret.charCodeAt(0).toString(16)}${secret.slice(1)}`
  expect(request(`/pair/${encoded}`).statusCode).toBe(200)
  expect(request(`/pair/${secret}`).statusCode).toBe(403)
  expect(commandHandler).not.toHaveBeenCalled()
})
