import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function readInstallCommands(workflowFile: string): string[] {
  const workflow = readFileSync(resolve('.github/workflows', workflowFile), 'utf8')

  return [...workflow.matchAll(/- name: Install dependencies\s+run: (.+)/g)].map(([, command]) =>
    command.trim()
  )
}

describe('CI workflow dependency installation policy', () => {
  test.each([
    ['ci.yml', ['npm ci --ignore-scripts']],
    ['azure-static-web-apps-zealous-river-03bbb7100.yml', ['npm ci --ignore-scripts']],
    ['build-release.yml', ['npm ci --ignore-scripts', 'npm ci']]
  ])(
    'skips desktop native rebuilds only outside packaged jobs in %s',
    (workflowFile, expectedCommands) => {
      expect(readInstallCommands(workflowFile)).toEqual(expectedCommands)
    }
  )
})

describe('release contract', () => {
  test('retries each release asset upload before leaving the release as a draft', () => {
    const workflow = readFileSync(resolve('.github/workflows/build-release.yml'), 'utf8')

    expect(workflow).toContain('for attempt in 1 2 3; do')
    expect(workflow).toContain('timeout 30m gh release upload')
    expect(workflow).toContain('sleep $((attempt * 15))')
  })

  test('keeps package versions aligned and the media sync runbook ACL-only', () => {
    const packageManifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      version: string
    }
    const lockManifest = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as {
      version: string
      packages: { '': { version: string } }
    }
    const runbook = readFileSync(resolve('docs/release/media-sync-runbook.md'), 'utf8')

    expect(lockManifest.version).toBe(packageManifest.version)
    expect(lockManifest.packages[''].version).toBe(packageManifest.version)
    expect(runbook).not.toContain('media_sync_user')
    expect(runbook).not.toMatch(/\bPR #\d+\b/)
    expect(runbook).not.toMatch(/revoke[^\n]*403/i)
    expect(runbook).toContain('direct-user ACL')
    expect(runbook).toContain('role-UUID ACL')
    expect(runbook).toContain('scoped `404`')
  })
})
