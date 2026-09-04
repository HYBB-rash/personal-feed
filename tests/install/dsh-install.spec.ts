import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installDshIntegration, probePersonalFeed, rollbackDshIntegration } from '../../src/install/dsh.ts'

const SKILL_TEXT = '---\nname: personal-feed\ndescription: Personal Feed via MCP\n---\n'

describe('DSH integration installer', () => {
  it('makes check mode mutation-free', async () => {
    const fixture = await makeFixture()
    const result = await installDshIntegration({ ...fixture.options, mode: 'check' })
    expect(result.changed).toBe(false)
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.stringContaining('verify /readyz'),
      expect.stringContaining('install Skill'),
      expect.stringContaining('cordis.patch.yml'),
    ]))
    await expect(lstat(join(fixture.dshHome, 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('installs atomically, backs up, uses 0600 env, and is idempotent', async () => {
    const fixture = await makeFixture()
    const first = await installDshIntegration({ ...fixture.options, mode: 'apply' })
    expect(first.changed).toBe(true)
    expect(first.backupDir).toBeTruthy()
    expect(first.rollbackCommand).toContain('personal-feed dsh rollback --apply')

    const patch = await readFile(join(fixture.dshHome, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('# BEGIN personal-feed installer managed block v1')
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(patch).toContain('serverName: personal_feed')
    expect(patch).toContain('failOnStartupError: false')
    expect(patch).toContain('toolCallTimeoutMs: 120000')
    expect(patch).not.toContain(fixture.token)

    const envPath = join(fixture.dshHome, '.env')
    const env = await readFile(envPath, 'utf8')
    expect(env).toContain('PERSONAL_FEED_MCP_URL="http://127.0.0.1:43180/mcp"')
    expect(env).toContain(`PERSONAL_FEED_MCP_TOKEN="${fixture.token}"`)
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(fixture.dshHome, 'skills/personal-feed/SKILL.md'), 'utf8')).toBe(SKILL_TEXT)

    const second = await installDshIntegration({ ...fixture.options, mode: 'apply' })
    expect(second.changed).toBe(false)
  })

  it('refuses unowned config and user Skill, but replaces the exact legacy image symlink', async () => {
    const configConflict = await makeFixture()
    await writeFile(join(configConflict.dshHome, 'cordis.patch.yml'), '- insert:\n    - id: personal-feed-mcp\n')
    await expect(installDshIntegration({ ...configConflict.options, mode: 'apply' }))
      .rejects.toThrow(/not owned/i)

    const serverNameConflict = await makeFixture()
    await writeFile(join(serverNameConflict.dshHome, 'cordis.patch.yml'), '- insert:\n    - id: user-row\n      config:\n        serverName: personal_feed\n')
    await expect(installDshIntegration({ ...serverNameConflict.options, mode: 'apply' }))
      .rejects.toThrow(/not owned/i)

    const skillConflict = await makeFixture()
    await mkdir(join(skillConflict.dshHome, 'skills/personal-feed'), { recursive: true })
    await writeFile(join(skillConflict.dshHome, 'skills/personal-feed/SKILL.md'), 'user content\n')
    await expect(installDshIntegration({ ...skillConflict.options, mode: 'apply' }))
      .rejects.toThrow(/user.*Skill/i)

    const legacy = await makeFixture()
    await mkdir(join(legacy.dshHome, 'skills'), { recursive: true })
    await symlink('/opt/dsh/plugins-src/skills/personal-feed', join(legacy.dshHome, 'skills/personal-feed'))
    const result = await installDshIntegration({ ...legacy.options, mode: 'apply' })
    expect(result.changed).toBe(true)
    expect((await lstat(join(legacy.dshHome, 'skills/personal-feed'))).isDirectory()).toBe(true)
  })

  it('compares and refreshes the complete installer-owned Skill tree', async () => {
    const fixture = await makeFixture()
    await mkdir(join(fixture.options.skillSourceDir, 'agents'))
    await writeFile(join(fixture.options.skillSourceDir, 'agents/openai.yaml'), 'version: one\n')
    await installDshIntegration({ ...fixture.options, mode: 'apply' })

    await writeFile(join(fixture.options.skillSourceDir, 'agents/openai.yaml'), 'version: two\n')
    const refreshed = await installDshIntegration({ ...fixture.options, mode: 'apply' })
    expect(refreshed.changed).toBe(true)
    expect(await readFile(join(fixture.dshHome, 'skills/personal-feed/agents/openai.yaml'), 'utf8')).toBe('version: two\n')
  })

  it('refuses symlinked shared DSH files without replacing the links or their targets', async () => {
    for (const targetName of ['.env', 'cordis.patch.yml']) {
      const fixture = await makeFixture()
      const external = join(fixture.dshHome, `user-${targetName.replaceAll('.', '')}`)
      const target = join(fixture.dshHome, targetName)
      await writeFile(external, 'USER_CONTENT=keep\n')
      await symlink(external, target)

      await expect(installDshIntegration({ ...fixture.options, mode: 'check' })).rejects.toThrow(/symbolic link/i)
      expect((await lstat(target)).isSymbolicLink()).toBe(true)
      await expect(readFile(external, 'utf8')).resolves.toBe('USER_CONTENT=keep\n')
    }
  })

  it('restores every changed file through the generated backup', async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.dshHome, '.env'), 'EXISTING=value\n', { mode: 0o640 })
    const installed = await installDshIntegration({ ...fixture.options, mode: 'apply' })
    if (installed.backupDir === undefined) throw new Error('expected backup')
    await rollbackDshIntegration({ dshHome: fixture.dshHome, backupDir: installed.backupDir })
    expect(await readFile(join(fixture.dshHome, '.env'), 'utf8')).toBe('EXISTING=value\n')
    expect((await lstat(join(fixture.dshHome, '.env'))).mode & 0o777).toBe(0o640)
    await expect(lstat(join(fixture.dshHome, 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(fixture.dshHome, 'skills/personal-feed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports and repairs mode drift on the shared secret environment', async () => {
    const fixture = await makeFixture()
    await installDshIntegration({ ...fixture.options, mode: 'apply' })
    const envPath = join(fixture.dshHome, '.env')
    await chmod(envPath, 0o644)

    const checked = await installDshIntegration({ ...fixture.options, mode: 'check' })
    expect(checked.changed).toBe(false)
    expect(checked.actions.join('\n')).toMatch(/restore.*0600/i)
    expect((await lstat(envPath)).mode & 0o777).toBe(0o644)

    const repaired = await installDshIntegration({ ...fixture.options, mode: 'apply' })
    expect(repaired.changed).toBe(true)
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600)
  })

  it.each([
    'https://127.0.0.1:43180',
    'http://localhost:43180',
    'http://127.0.0.1:43180/mcp',
    'http://user@127.0.0.1:43180',
    'http://127.0.0.1:43180/?injected=true',
    'http://127.0.0.1:43180\nINJECTED=yes',
  ])('rejects a non-loopback-origin service URL: %s', async serviceUrl => {
    const fixture = await makeFixture()
    await expect(installDshIntegration({ ...fixture.options, serviceUrl, mode: 'check' })).rejects.toThrow(/loopback HTTP origin/i)
  })

  it('requires the readiness body to say ready before opening MCP', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    try {
      await expect(probePersonalFeed('http://127.0.0.1:43180', 'token-1234567890abcdef')).rejects.toThrow(/not ready/i)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-feed-dsh-install-'))
  const dshHome = join(root, 'dsh')
  const skillSourceDir = join(root, 'skill')
  await mkdir(dshHome)
  await mkdir(skillSourceDir)
  await writeFile(join(skillSourceDir, 'SKILL.md'), SKILL_TEXT)
  const token = 'test-mcp-token-1234567890'
  return {
    dshHome,
    token,
    options: {
      dshHome,
      serviceUrl: 'http://127.0.0.1:43180',
      mcpToken: token,
      skillSourceDir,
      probe: async () => ({ tools: ['request', 'observe_context', 'process_feedback', 'record_feedback', 'list_saved'] }),
      now: () => new Date('2026-09-04T00:00:00.000Z'),
    },
  }
}
