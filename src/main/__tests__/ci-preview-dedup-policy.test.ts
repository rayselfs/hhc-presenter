import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const azure = readFileSync(
  '.github/workflows/azure-static-web-apps-zealous-river-03bbb7100.yml',
  'utf8'
)

function job(workflow: string, name: string): string {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_\\-]+:|$(?![\\s\\S]))`, 'm')
  )
  expect(match, `Missing job ${name}`).not.toBeNull()
  return match![1]
}

describe('same-run PR hosted renderer validation', () => {
  test('runs shared gates exactly once and preserves default and hosted build inputs', () => {
    const producer = job(ci, 'quality-build')
    for (const command of [
      'npm run lint',
      'npm run typecheck',
      'npx vitest run',
      'npm run build',
      'npm run build:web'
    ]) {
      expect(ci.split(`run: ${command}\n`)).toHaveLength(2)
      expect(producer).toContain(`run: ${command}\n`)
    }
    expect(producer).toContain(
      'e2e/hosted-artifact.spec.ts --project=chromium --workers=1 --retries=0'
    )
    for (const name of [
      'HHC_ACCOUNT_ORIGIN',
      'HHC_ASSET_ORIGIN',
      'ONEDRIVE_CLIENT_ID',
      'BIBLE_API_HOST',
      'BIBLE_API_V1_PREFIX',
      'BIBLE_API_V2_PREFIX'
    ]) {
      expect(producer.split(`VITE_${name}:`)).toHaveLength(3)
    }
    expect(producer).toContain(
      'name: hosted-renderer-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'
    )
    expect(producer).toContain('retention-days: 1')
    expect(producer).toContain('include-hidden-files: true')
    expect(producer).toContain('if-no-files-found: error')
  })

  test('makes the original required quality job fail when producer fails', () => {
    const browser = job(ci, 'quality-gates')
    expect(browser).toContain('needs: quality-build')
    expect(browser).toContain('if: always()')
    expect(browser).toContain('QUALITY_BUILD_RESULT: ${{ needs.quality-build.result }}')
    expect(browser).toContain('run: test "$QUALITY_BUILD_RESULT" = success')
    expect(browser).toContain('run: npm run test:e2e:browser')
    expect(browser).not.toContain('npm run build')
  })

  test('feeds both consumers only the exact successful producer artifact and fails on tampering', () => {
    for (const name of ['quality-gates', 'build_and_deploy_job']) {
      const consumer = job(ci, name)
      expect(consumer).toContain(
        'artifact-ids: ${{ needs.quality-build.outputs.renderer-artifact-id }}'
      )
      expect(consumer).toContain('path: out/renderer')
      expect(consumer).toContain(
        'EXPECTED_SHA256: ${{ needs.quality-build.outputs.renderer-sha256 }}'
      )
      expect(consumer).toContain(
        'find out/renderer -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum'
      )
      expect(consumer).toContain('test "$actual" = "$EXPECTED_SHA256"')
      expect(consumer).toContain('test -z "$(find out/renderer -type l -print -quit)"')
      expect(consumer).not.toContain('continue-on-error:')
      expect(consumer).not.toContain('run-id:')
    }
  })

  test('isolates deploy credentials from source execution and keeps cleanup separate', () => {
    const deploy = job(ci, 'build_and_deploy_job')
    expect(deploy).toContain('needs: [quality-build, cleanup_stale_previews]')
    expect(deploy).not.toContain('quality-gates')
    expect(deploy).toContain('contents: read')
    expect(deploy).toContain('pull-requests: read')
    expect(deploy).not.toMatch(/checkout|npm |id-token:|packages:|always\(\)/)
    expect(deploy).toContain('skip_app_build: true')
    const cleanup = job(ci, 'cleanup_stale_previews')
    expect(cleanup).toContain('id-token: write')
    expect(cleanup).not.toContain('checkout')
    expect(ci).not.toMatch(/pull_request_target|workflow_run|secrets: inherit/)
  })

  test('keeps production release validation and closed-preview cleanup in their original workflow', () => {
    expect(ci).toContain('pull_request:')
    expect(ci).not.toMatch(/^ {2}(push|release|workflow_dispatch):/m)
    expect(azure).toContain('release:\n    types: [published]')
    expect(azure).toContain('pull_request:\n    types: [closed]')
    expect(job(azure, 'build_and_deploy_job')).toContain("if: github.event_name == 'release'")
    for (const command of ['npm run lint', 'npx vitest run', 'npm run build:web']) {
      expect(job(azure, 'build_and_deploy_job')).toContain(`run: ${command}`)
    }
    expect(job(azure, 'build_and_deploy_job')).toContain(
      'e2e/hosted-artifact.spec.ts --project=chromium --workers=1 --retries=0'
    )
    expect(job(azure, 'close_pull_request_job')).toContain("github.event.action == 'closed'")
    expect(job(azure, 'close_pull_request_job')).toContain("action: 'close'")
  })
})
