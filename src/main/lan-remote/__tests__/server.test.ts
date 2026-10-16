import { networkInterfaces } from 'node:os'
import { expect, it, vi } from 'vitest'
import { isPrivateLanAddress } from '../../../shared/lan-remote'
import { createLanRemoteServer } from '../server'

function getPrivateHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isPrivateLanAddress(address.address)) {
        return address.address
      }
    }
  }
  throw new Error('LAN remote tests require an assigned private IPv4 address')
}

it('starts disabled and creates one-use pairing secrets', async () => {
  const server = createLanRemoteServer({
    commandHandler: async () => ({ requestId: 'x', status: 'accepted' })
  })

  expect(server.getStatus().enabled).toBe(false)
  expect(() => server.createPairingSecret('Device')).toThrow('not running')

  await server.start({ host: getPrivateHost(), port: 0 })
  const pairing = server.createPairingSecret('Device')

  expect(server.getStatus().enabled).toBe(true)
  expect(pairing.url).toContain('/pair/')
  expect(server.consumePairingSecret(pairing.secret)?.deviceName).toBe('Device')
  expect(server.consumePairingSecret(pairing.secret)).toBeNull()

  await server.stop()
  expect(server.getStatus().enabled).toBe(false)
})

it('pairs a browser session and accepts authorized commands', async () => {
  const commandHandler = vi.fn(async (command) => ({
    requestId: command.requestId,
    status: 'accepted' as const
  }))
  const server = createLanRemoteServer({ commandHandler })
  const host = getPrivateHost()

  await server.start({ host, port: 0 })
  const { port } = server.getStatus()
  const pairing = server.createPairingSecret('Phone')
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()

  const pairResponse = await fetch(`http://${host}:${port}/pair/${pairing.secret}`)
  const html = await pairResponse.text()
  const token = html.match(/const sessionToken = "([^"]+)"/)?.[1]

  expect(token).toBeTruthy()

  const unauthorized = await fetch(`http://${host}:${port}/state`)
  expect(unauthorized.status).toBe(401)

  const commandResponse = await fetch(`http://${host}:${port}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hhc-presenter-session': token!
    },
    body: JSON.stringify({ requestId: 'r1', type: 'presentation:next' })
  })

  expect(commandResponse.status).toBe(200)
  await expect(commandResponse.json()).resolves.toEqual({ requestId: 'r1', status: 'accepted' })
  expect(commandHandler).toHaveBeenCalledWith({ requestId: 'r1', type: 'presentation:next' })

  server.publishState({
    revision: 1,
    presentation: { currentIndex: 0, total: 1, currentName: 'A', canNext: false },
    projection: { isOpen: true }
  })
  const stateResponse = await fetch(`http://${host}:${port}/state`, {
    headers: { 'x-hhc-presenter-session': token! }
  })
  await expect(stateResponse.json()).resolves.toMatchObject({
    snapshot: {
      revision: 1,
      presentation: { currentName: 'A' },
      projection: { isOpen: true }
    }
  })

  await server.stop()
})

it('keeps serving after malformed unauthenticated pairing requests', async () => {
  const commandHandler = vi.fn(async () => ({ requestId: 'x', status: 'accepted' as const }))
  const server = createLanRemoteServer({ commandHandler })
  const host = getPrivateHost()
  await server.start({ host, port: 0 })
  const origin = `http://${host}:${server.getStatus().port}`
  try {
    for (const path of ['%', '%GG', '%E0%A4%A']) {
      const response = await fetch(`${origin}/pair/${path}`)
      expect(response.status).toBe(400)
      await response.text()
    }
    const response = await fetch(`${origin}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<html')
    expect(commandHandler).not.toHaveBeenCalled()
    expect(server.getStatus().enabled).toBe(true)
  } finally {
    await server.stop()
  }
})
