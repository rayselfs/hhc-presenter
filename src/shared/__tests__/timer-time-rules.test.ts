import { describe, expect, it } from 'vitest'
import { computePhase, computeProgress, readCountdownAt } from '../timer-time-rules'

describe('timer time rules', () => {
  it.each([
    [1001, 2, 0],
    [1000, 1, 0],
    [1, 1, 0],
    [0, 0, 0],
    [-1, 0, 1],
    [-1000, 0, 1],
    [-1001, 0, 2],
    [-6500, 0, 7]
  ])('retains deadline rounding at %i ms', (remainingMs, remainingSeconds, overtimeSeconds) => {
    expect(readCountdownAt(10000, 10000 - remainingMs)).toEqual({
      remainingMs,
      remainingSeconds,
      overtimeSeconds
    })
  })

  it('uses caller clock coordinates without reading wall time', () => {
    expect(readCountdownAt(5000, 3500)).toEqual(readCountdownAt(1700000005000, 1700000003500))
  })

  it.each([
    ['stopped', 0, true, 30, 'idle'],
    ['paused', 0, false, 0, 'overtime'],
    ['running', 31, true, 30, 'main'],
    ['running', 30, true, 30, 'warning'],
    ['running', 30, false, 30, 'main']
  ] as const)('retains phase for %s at %i seconds', (status, seconds, enabled, reminder, phase) => {
    expect(computePhase(status, seconds, enabled, reminder)).toBe(phase)
  })

  it.each([
    [500, 1000, 0.5],
    [1500, 1000, 1],
    [-100, 1000, 0],
    [0, 0, 0]
  ])('clamps progress with matching duration units', (remaining, total, expected) => {
    expect(computeProgress(remaining, total)).toBe(expected)
    expect(computeProgress(remaining / 1000, total / 1000)).toBe(expected)
  })
})
