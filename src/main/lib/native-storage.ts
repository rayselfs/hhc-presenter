import { app } from 'electron'
import { dirname, resolve } from 'path'
import { isValidNativeFileId } from '../../shared/native-media'

export function getNativeFsDir(): string {
  return resolve(app.getPath('userData'), 'native-files')
}

export function getNativeFilePath(id: unknown): string {
  if (!isValidNativeFileId(id)) throw new Error('Invalid native file id')

  const baseDir = getNativeFsDir()
  const filePath = resolve(baseDir, id)
  if (dirname(filePath) !== baseDir) throw new Error('Native file path escapes storage directory')
  return filePath
}
