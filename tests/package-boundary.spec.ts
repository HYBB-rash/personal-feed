import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const forbiddenRuntimeReferences = [
  /telegram/iu,
  /cordis/iu,
  /deepseek[ -]?harness/iu,
  /DSH_HOME/u,
  /chatId/u,
  /messageId/u,
  /sessionId/u,
  /@deepseek-ai/iu,
  /@herman/iu,
]

describe('standalone package boundary', () => {
  it('has no host-runtime or channel package dependency', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).join('\n')
    for (const forbidden of forbiddenRuntimeReferences) expect(dependencyNames).not.toMatch(forbidden)
  })

  it('keeps the running service and observer free of DSH and channel identity', async () => {
    const runtimeFiles = [
      ...(await sourceFiles('src')).filter((file) => !file.startsWith('src/install/') && file !== 'src/cli.ts'),
      ...(await sourceFiles('python')).filter((file) => !file.startsWith('python/test_')),
    ]
    for (const file of runtimeFiles) {
      const contents = await readFile(file, 'utf8')
      for (const forbidden of forbiddenRuntimeReferences) {
        expect(contents, `${file} contains ${forbidden}`).not.toMatch(forbidden)
      }
    }
  })
})

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (/\.(?:ts|py)$/u.test(entry.name)) files.push(relative('.', path))
  }
  return files.sort()
}
