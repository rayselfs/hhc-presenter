import { createHash, randomUUID } from 'node:crypto'
import { projectHhcSourceControl, type HhcSourceControl } from '@shared/hhc-assets'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isValidNativeFileId } from '@shared/native-media'

function policyPath(id: string): string {
  if (!isValidNativeFileId(id)) throw new Error('Invalid native file id')
  return join(app.getPath('userData'), 'hhc-source-policies', `${id}.json`)
}

export async function readNativeSourceDeadline(id: string): Promise<number | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(policyPath(id), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('deadline' in value) ||
    typeof value.deadline !== 'number' ||
    !Number.isFinite(value.deadline) ||
    value.deadline <= 0
  )
    throw new Error('Invalid native source policy')
  if (value.deadline <= Date.now()) throw new Error('HHC_SOURCE_FAILURE:410:item-expired')
  if ('collectionId' in value) {
    if (typeof value.collectionId !== 'string') throw new Error('Invalid native source policy')
    let control: HhcSourceControl | undefined
    try {
      control = projectHhcSourceControl(
        JSON.parse(await fs.readFile(controlPath(value.collectionId), 'utf8'))
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (control && control.state !== 'active')
      throw new Error(
        control.state === 'paused'
          ? 'HHC_SOURCE_FAILURE:423:collection-paused'
          : 'HHC_SOURCE_FAILURE:410:collection-revoked'
      )
  }
  return value.deadline
}

export async function persistNativeSourceDeadline(
  id: string,
  deadline: number,
  collectionId?: string
): Promise<void> {
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw new Error('HHC_SOURCE_FAILURE:410:item-expired')
  const file = policyPath(id)
  await fs.mkdir(join(app.getPath('userData'), 'hhc-source-policies'), { recursive: true })
  try {
    await fs.writeFile(
      file,
      JSON.stringify({ deadline, ...(collectionId ? { collectionId } : {}) }),
      { flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if ((await readNativeSourceDeadline(id)) !== deadline)
      throw new Error('Immutable source deadline changed')
  }
}

function controlPath(collectionId: string): string {
  return join(
    app.getPath('userData'),
    'hhc-source-policies',
    `collection-${createHash('sha256').update(collectionId).digest('hex')}.json`
  )
}
let controlWrites: Promise<void> = Promise.resolve()
export function persistNativeSourceControl(control: HhcSourceControl): Promise<void> {
  const write = controlWrites
    .catch(() => undefined)
    .then(async () => {
      const file = controlPath(control.collectionId)
      let previous: HhcSourceControl | undefined
      try {
        previous = projectHhcSourceControl(JSON.parse(await fs.readFile(file, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        previous &&
        (previous.policyRevision > control.policyRevision ||
          previous.aclRevision > control.aclRevision ||
          previous.bindingGeneration > control.bindingGeneration)
      )
        throw new Error('HHC_SOURCE_FAILURE:503:dependency-unavailable')
      await fs.mkdir(join(app.getPath('userData'), 'hhc-source-policies'), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify(control), { mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, file)
      } finally {
        await fs.rm(temporary, { force: true })
      }
    })
  controlWrites = write
  return write
}
