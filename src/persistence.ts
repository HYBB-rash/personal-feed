import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PersonalFeedStorageError } from './errors.ts'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (cause) {
    if (isMissing(cause)) return fallback
    throw new PersonalFeedStorageError(`could not read ${path}`, { cause })
  }
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (cause) {
    if (isMissing(cause)) return []
    throw new PersonalFeedStorageError(`could not read ${path}`, { cause })
  }
  const values: T[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      values.push(JSON.parse(line) as T)
    } catch (cause) {
      throw new PersonalFeedStorageError(`invalid JSONL in ${path}`, { cause })
    }
  }
  return values
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if (cause instanceof PersonalFeedStorageError) throw cause
    throw new PersonalFeedStorageError(`could not append ${path}`, { cause })
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path)
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    const directoryHandle = await open(directory, constants.O_RDONLY)
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (cause) {
    try { await unlink(temporary) } catch { /* best effort cleanup */ }
    throw new PersonalFeedStorageError(`could not atomically replace ${path}`, { cause })
  }
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}
