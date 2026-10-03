import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { getProjectionDiagnosticMode, recordProjectionDiagnostic } from '../projectionDiagnostic'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '2.6.4' },
  screen: {
    getPrimaryDisplay: () => ({ id: 1 }),
    getAllDisplays: () => [
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    ]
  }
}))

it('enables only explicitly selected Windows diagnostic modes', () => {
  expect(getProjectionDiagnosticMode([], 'win32')).toBeUndefined()
  for (const mode of ['baseline', 'after-show', 'resize-after-fullscreen']) {
    const args = [`--projection-diagnostic=${mode}`]
    expect(getProjectionDiagnosticMode(args, 'win32')).toBe(mode)
    expect(getProjectionDiagnosticMode(args, 'darwin')).toBeUndefined()
  }
  expect(() => getProjectionDiagnosticMode(['--projection-diagnostic=unknown'], 'win32')).toThrow()
})

it('writes local structured geometry only when explicitly enabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'projection-diagnostic-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const argv = process.argv
  vi.mocked(app.getPath).mockReturnValue(directory)
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.argv = []
    recordProjectionDiagnostic('disabled')
    expect(readdirSync(directory)).toEqual([])
    process.argv = ['--projection-diagnostic=baseline']
    recordProjectionDiagnostic('before-create')
    const record = JSON.parse(
      readFileSync(
        join(directory, 'projection-diagnostics', `baseline-${process.pid}.jsonl`),
        'utf8'
      )
    )
    expect(record).toMatchObject({
      mode: 'baseline',
      phase: 'before-create',
      appVersion: '2.6.4',
      displays: [{ id: 2, scaleFactor: 1 }]
    })
    expect(record.window).toBeUndefined()
  } finally {
    process.argv = argv
    Object.defineProperty(process, 'platform', platform)
    rmSync(directory, { recursive: true, force: true })
  }
})
