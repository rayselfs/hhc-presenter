import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  isPrivateLanAddress,
  parseLanRemoteCommand,
  sanitizeLanRemoteSnapshot,
  type LanRemoteAck,
  type LanRemoteCommand,
  type LanRemoteSnapshot
} from '../../shared/lan-remote'
import { getLanRemoteMobileHtml } from './mobile-ui'

export interface LanRemoteServerStartOptions {
  host: string
  port: number
}

export interface LanRemotePairingRecord {
  secret: string
  deviceName: string
  expiresAt: number
}

export interface LanRemoteServerStatus {
  enabled: boolean
  host: string
  port: number
}

export interface LanRemoteServerOptions {
  commandHandler: (command: LanRemoteCommand) => Promise<LanRemoteAck>
}

export interface LanRemoteServerController {
  start(options: LanRemoteServerStartOptions): Promise<void>
  stop(): Promise<void>
  createPairingSecret(deviceName: string): {
    secret: string
    url: string
    expiresAt: number
  }
  consumePairingSecret(secret: string): LanRemotePairingRecord | null
  publishState(snapshot: unknown): void
  getStatus(): LanRemoteServerStatus
}

function readRequestJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString('utf8')
      if (body.length > 64 * 1024) {
        req.destroy()
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null)
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

export function createLanRemoteServer(
  serverOptions: LanRemoteServerOptions
): LanRemoteServerController {
  let server: Server | null = null
  let host = ''
  let port = 0
  const pairings = new Map<string, LanRemotePairingRecord>()
  const sessions = new Set<string>()
  let latestSnapshot: LanRemoteSnapshot = sanitizeLanRemoteSnapshot({})
  let latestAck: LanRemoteAck | null = null

  function isAuthorized(req: IncomingMessage): boolean {
    const token = req.headers['x-hhc-presenter-session']
    return typeof token === 'string' && sessions.has(token)
  }

  function consumePairing(secret: string): LanRemotePairingRecord | null {
    const record = pairings.get(secret)
    pairings.delete(secret)
    if (!record || record.expiresAt < Date.now()) return null
    return record
  }

  return {
    async start(startOptions: LanRemoteServerStartOptions): Promise<void> {
      if (server) return
      if (!isPrivateLanAddress(startOptions.host)) {
        throw new Error('LAN remote requires a private LAN interface')
      }

      const nextServer = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/') {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(getLanRemoteMobileHtml())
          return
        }
        if (req.method === 'GET' && req.url?.startsWith('/pair/')) {
          let secret: string
          try {
            secret = decodeURIComponent(req.url.slice('/pair/'.length))
          } catch {
            res.statusCode = 400
            res.end('Invalid pairing URL')
            return
          }
          const pairing = consumePairing(secret)
          if (!pairing) {
            res.statusCode = 403
            res.end('Pairing expired')
            return
          }

          const sessionToken = randomBytes(32).toString('base64url')
          sessions.add(sessionToken)
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(getLanRemoteMobileHtml(sessionToken))
          return
        }
        if (req.method === 'GET' && req.url === '/state') {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { error: 'unauthorized' })
            return
          }
          sendJson(res, 200, { snapshot: latestSnapshot, ack: latestAck })
          return
        }
        if (req.method === 'POST' && req.url === '/command') {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { error: 'unauthorized' })
            return
          }

          void readRequestJson(req)
            .then(parseLanRemoteCommand)
            .then(async (command) => {
              if (!command) {
                sendJson(res, 400, { error: 'invalid-command' })
                return
              }
              const ack = await serverOptions.commandHandler(command)
              latestAck = ack
              sendJson(res, 200, ack)
            })
            .catch((error: unknown) => {
              sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad-request' })
            })
          return
        }

        res.statusCode = 404
        res.end('Not found')
      })

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        nextServer.once('error', onError)
        nextServer.listen(startOptions.port, startOptions.host, () => {
          nextServer.off('error', onError)
          resolve()
        })
      })

      const address = nextServer.address()
      host = startOptions.host
      port = startOptions.port
      if (typeof address === 'object' && address) {
        port = address.port
      }
      server = nextServer
    },

    async stop(): Promise<void> {
      if (!server) return

      const current = server
      server = null
      pairings.clear()
      sessions.clear()
      await new Promise<void>((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()))
      })
    },

    createPairingSecret(deviceName: string): {
      secret: string
      url: string
      expiresAt: number
    } {
      if (!server) throw new Error('LAN remote is not running')
      const secret = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + 2 * 60 * 1000
      pairings.set(secret, { secret, deviceName, expiresAt })
      return { secret, expiresAt, url: `http://${host}:${port}/pair/${secret}` }
    },

    consumePairingSecret(secret: string): LanRemotePairingRecord | null {
      return consumePairing(secret)
    },

    publishState(snapshot: unknown): void {
      latestSnapshot = sanitizeLanRemoteSnapshot(snapshot)
    },

    getStatus(): LanRemoteServerStatus {
      return { enabled: server !== null, host, port }
    }
  }
}
