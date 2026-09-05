import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

interface BackupEntry {
  readonly target: string
  readonly existed: boolean
  readonly kind?: 'file' | 'directory' | 'symlink'
  readonly mode?: number
  readonly backupName?: string
  readonly linkTarget?: string
}

interface BackupManifest {
  readonly version: 1
  readonly entries: readonly BackupEntry[]
}

export async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return ''
    throw error
  }
}

export async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, mode)
  await rename(temporary, path)
}

export async function createBackup(
  backupRoot: string,
  name: string,
  targets: readonly string[],
): Promise<string> {
  const backupDir = join(backupRoot, name)
  await mkdir(backupDir, { recursive: false, mode: 0o700 })
  const entries: BackupEntry[] = []
  for (const [index, target] of targets.entries()) {
    let metadata
    try {
      metadata = await lstat(target)
    } catch (error) {
      if (isNotFound(error)) {
        entries.push({ target, existed: false })
        continue
      }
      throw error
    }
    const backupName = `entry-${index}`
    if (metadata.isSymbolicLink()) {
      entries.push({ target, existed: true, kind: 'symlink', linkTarget: await readlink(target) })
    } else if (metadata.isDirectory()) {
      await cp(target, join(backupDir, backupName), { recursive: true })
      entries.push({ target, existed: true, kind: 'directory', mode: metadata.mode & 0o777, backupName })
    } else {
      await copyFile(target, join(backupDir, backupName))
      entries.push({ target, existed: true, kind: 'file', mode: metadata.mode & 0o777, backupName })
    }
  }
  const manifest: BackupManifest = { version: 1, entries }
  await atomicWrite(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 0o600)
  return backupDir
}

export async function restoreBackup(backupDir: string, allowedRoots: readonly string[]): Promise<void> {
  const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('invalid Personal Feed backup manifest')
  for (const entry of manifest.entries) {
    if (!allowedRoots.some(root => entry.target === root || entry.target.startsWith(`${root}/`))) {
      throw new Error(`backup target is outside the allowed roots: ${entry.target}`)
    }
  }
  for (const entry of manifest.entries.toReversed()) {
    await rm(entry.target, { recursive: true, force: true })
    if (!entry.existed) continue
    await mkdir(dirname(entry.target), { recursive: true, mode: 0o700 })
    if (entry.kind === 'symlink' && entry.linkTarget !== undefined) {
      await symlink(entry.linkTarget, entry.target)
    } else if (entry.kind === 'directory' && entry.backupName !== undefined) {
      await cp(join(backupDir, entry.backupName), entry.target, { recursive: true })
      if (entry.mode !== undefined) await chmod(entry.target, entry.mode)
    } else if (entry.kind === 'file' && entry.backupName !== undefined) {
      await copyFile(join(backupDir, entry.backupName), entry.target)
      if (entry.mode !== undefined) await chmod(entry.target, entry.mode)
    } else {
      throw new Error('invalid Personal Feed backup entry')
    }
  }
}

export function backupName(prefix: string, now: Date): string {
  return `${prefix}-${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`
}

export function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
