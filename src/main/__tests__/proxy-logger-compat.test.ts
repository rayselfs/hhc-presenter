import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const probe = String.raw`
const assert = require('node:assert/strict')
const http = require('node:http')
const { createRequire } = require('node:module')
const req = createRequire(process.cwd() + '/package.json')
const server = http.createServer((request, response) => {
  assert.equal(new URL(request.url).hostname, 'origin.invalid')
  if (new URL(request.url).pathname === '/reset') request.socket.destroy()
  else response.end('synthetic proxy response')
})
async function get(path) {
  return new Promise((resolve, reject) => {
    const request = http.get('http://origin.invalid' + path, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve(body))
    })
    request.on('error', reject)
  })
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + server.address().port
    process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.GLOBAL_AGENT_HTTP_PROXY
    process.env.GLOBAL_AGENT_NO_PROXY = ''
    if (process.env.PROBE_ENTRY === 'electron-get') {
      const builder = createRequire(req.resolve('app-builder-lib/package.json'))
      builder('@electron/get').initializeProxy()
    } else req('global-agent').bootstrap()
    assert.equal(req('global-agent').bootstrap(), false)
    assert.equal(await get('/ok'), 'synthetic proxy response')
    await assert.rejects(get('/reset'), { code: 'ECONNRESET' })
    console.log('PROBE_DONE')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
`

describe('installed proxy logger compatibility', () => {
  it.each([
    ['bootstrap', 'false'],
    ['bootstrap', 'true'],
    ['electron-get', 'false'],
    ['electron-get', 'true']
  ])('preserves %s transport with logging=%s', async (entry, logging) => {
    const { stdout } = await execFileAsync(process.execPath, ['-e', probe], {
      env: { ...process.env, PROBE_ENTRY: entry, ROARR_LOG: logging, ROARR_STREAM: 'stdout' },
      timeout: 4000
    })
    expect(stdout).toContain('PROBE_DONE')
    const messages: Array<{ message: string; context: { logLevel: number } }> = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
    if (logging === 'false') expect(messages).toEqual([])
    else {
      expect(messages.some((message) => message.context.logLevel === 10)).toBe(true)
      expect(messages.some((message) => message.context.logLevel === 50)).toBe(true)
      expect(messages.every((message) => typeof message.message === 'string')).toBe(true)
    }
  })
})
