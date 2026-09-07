import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runPersonalFeedCli } from '../../src/cli.ts'
import { installUserService, rollbackUserService } from '../../src/install/service.ts'

describe('user service installer', () => {
  it('keeps check mode read-only and reports the exact commit build plan', async () => {
    const fixture = await makeFixture()
    const result = await installUserService({ ...fixture.options, mode: 'check' })
    expect(result.changed).toBe(false)
    expect(result.actions.join('\n')).toContain('0123456789abcdef')
    expect(fixture.run).not.toHaveBeenCalledWith('systemctl', expect.anything())
    await expect(lstat(join(fixture.configHome, 'personal-feed/service.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps check mode usable on a dirty checkout and reports the apply blocker', async () => {
    const fixture = await makeFixture()
    fixture.gitStatus.mockResolvedValueOnce(' M README.md\n')
    const result = await installUserService({ ...fixture.options, mode: 'check' })
    expect(result.changed).toBe(false)
    expect(result.actions.join('\n')).toMatch(/apply requires a clean Git checkout/i)
    expect(fixture.run).not.toHaveBeenCalled()
    await expect(lstat(join(fixture.configHome, 'personal-feed/service.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires a clean exact Git commit before apply', async () => {
    const fixture = await makeFixture()
    fixture.gitStatus.mockResolvedValueOnce(' M README.md\n')
    await expect(installUserService({ ...fixture.options, mode: 'apply' })).rejects.toThrow(/clean Git checkout/i)
  })

  it('writes private config and unit, starts only on apply, stays idempotent, and rolls back', async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.root, 'existing-marker'), 'untouched')
    const first = await installUserService({ ...fixture.options, mode: 'apply' })
    expect(first.changed).toBe(true)
    expect(first.backupDir).toBeTruthy()
    const envPath = join(fixture.configHome, 'personal-feed/service.env')
    const env = await readFile(envPath, 'utf8')
    expect(env).toContain('PERSONAL_FEED_MCP_TOKEN="mcp-token-1234567890"')
    expect(env).toContain('PERSONAL_FEED_MODEL_API_KEY="model key \\"quote\\" \\\\ value"')
    expect(env).toContain('PERSONAL_FEED_MODEL_BASE_URL="http://127.0.0.1:18080/v1"')
    expect(env).toContain('PERSONAL_FEED_STATE_DIR="')
    expect(env).not.toContain('PERSONAL_FEED_MODEL_RESPONSE_FORMAT')
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600)
    const unit = await readFile(join(fixture.configHome, 'systemd/user/personal-feed.service'), 'utf8')
    expect(unit).toContain('# template-source')
    expect(unit).toContain('/nix/store/personal-feed/bin/personal-feed serve')
    const environmentFile = unit.split('\n').find(line => line.startsWith('EnvironmentFile='))!.slice('EnvironmentFile='.length)
    expect(isAbsolute(environmentFile)).toBe(true)
    expect(environmentFile).toBe(envPath)
    expect(unit).toContain('ReadWritePaths="')
    expect(fixture.run).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'])
    expect(fixture.run).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'personal-feed.service'])

    const second = await installUserService({ ...fixture.options, mode: 'apply' })
    expect(second.changed).toBe(false)
    const trialState = join(fixture.stateHome, 'personal-feed', 'saved.jsonl')
    await writeFile(trialState, '{"saved":true}\n')
    if (first.backupDir === undefined) throw new Error('expected backup')
    await rollbackUserService({
      configHome: fixture.configHome,
      backupDir: first.backupDir,
      run: fixture.run,
    })
    await expect(lstat(envPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(trialState, 'utf8')).resolves.toBe('{"saved":true}\n')
  })

  it.each(['json_content', 'strict_tool'] as const)('installs %s from the CLI into the private EnvironmentFile', async responseFormat => {
    const fixture = await makeFixture()
    await runPersonalFeedCli(['service', 'install', '--apply'], {
      environment: {
        HOME: fixture.root,
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
        PERSONAL_FEED_MCP_TOKEN: fixture.options.mcpToken,
        PERSONAL_FEED_MODEL_BASE_URL: fixture.options.model.baseURL,
        PERSONAL_FEED_MODEL: fixture.options.model.model,
        PERSONAL_FEED_MODEL_API_KEY: fixture.options.model.apiKey,
        PERSONAL_FEED_MODEL_RESPONSE_FORMAT: responseFormat,
      },
      cwd: () => fixture.root,
      installService: options => installUserService({ ...fixture.options, ...options }),
      rollbackService: vi.fn(), serve: vi.fn(), write: vi.fn(),
    })
    const envPath = join(fixture.configHome, 'personal-feed/service.env')
    expect(await readFile(envPath, 'utf8')).toContain(`PERSONAL_FEED_MODEL_RESPONSE_FORMAT="${responseFormat}"\n`)
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600)
  })

  it.each(['check', 'apply'] as const)('rejects an invalid response format before any installer effects in %s', async mode => {
    const fixture = await makeFixture()
    await expect(installUserService({
      ...fixture.options, mode, model: { ...fixture.options.model, responseFormat: 'invented' as never },
    })).rejects.toThrow(/responseFormat/)
    expect(fixture.run).not.toHaveBeenCalled()
    expect(fixture.gitStatus).not.toHaveBeenCalled()
    await expect(lstat(join(fixture.configHome, 'personal-feed/service.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses unowned service files and symlinks without changing them', async () => {
    const envConflict = await makeFixture()
    const envPath = join(envConflict.configHome, 'personal-feed/service.env')
    await mkdir(join(envConflict.configHome, 'personal-feed'), { recursive: true })
    await writeFile(envPath, 'USER_SECRET=keep\n')
    await expect(installUserService({ ...envConflict.options, mode: 'check' })).rejects.toThrow(/not owned/i)
    await expect(readFile(envPath, 'utf8')).resolves.toBe('USER_SECRET=keep\n')

    const unitConflict = await makeFixture()
    const unitPath = join(unitConflict.configHome, 'systemd/user/personal-feed.service')
    await mkdir(join(unitConflict.configHome, 'systemd/user'), { recursive: true })
    await writeFile(unitPath, 'ExecStart=user-unit\n')
    await expect(installUserService({ ...unitConflict.options, mode: 'apply' })).rejects.toThrow(/not owned/i)
    await expect(readFile(unitPath, 'utf8')).resolves.toBe('ExecStart=user-unit\n')

    const symlinkConflict = await makeFixture()
    const external = join(symlinkConflict.root, 'user-env')
    const linkPath = join(symlinkConflict.configHome, 'personal-feed/service.env')
    await mkdir(join(symlinkConflict.configHome, 'personal-feed'), { recursive: true })
    await writeFile(external, 'USER_SECRET=keep\n')
    await symlink(external, linkPath)
    await expect(installUserService({ ...symlinkConflict.options, mode: 'check' })).rejects.toThrow(/symbolic link/i)
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    await expect(readFile(external, 'utf8')).resolves.toBe('USER_SECRET=keep\n')
  })

  it('refuses an unowned state directory instead of adopting user data', async () => {
    const fixture = await makeFixture()
    const stateDir = join(fixture.stateHome, 'personal-feed')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'user-data'), 'keep\n')

    await expect(installUserService({ ...fixture.options, mode: 'check' })).rejects.toThrow(/state directory.*not owned/i)
    await expect(readFile(join(stateDir, 'user-data'), 'utf8')).resolves.toBe('keep\n')
  })

  it('reports and repairs mode drift on the owned secret environment', async () => {
    const fixture = await makeFixture()
    await installUserService({ ...fixture.options, mode: 'apply' })
    const envPath = join(fixture.configHome, 'personal-feed/service.env')
    await chmod(envPath, 0o644)

    const checked = await installUserService({ ...fixture.options, mode: 'check' })
    expect(checked.changed).toBe(false)
    expect(checked.actions.join('\n')).toMatch(/restore.*0600/i)
    expect((await lstat(envPath)).mode & 0o777).toBe(0o644)

    const repaired = await installUserService({ ...fixture.options, mode: 'apply' })
    expect(repaired.changed).toBe(true)
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600)
  })
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-feed-service-install-'))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state with space')
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'nix') return { stdout: '/nix/store/personal-feed\n' }
    return { stdout: '' }
  })
  const gitStatus = vi.fn(async () => '')
  return {
    root,
    configHome,
    stateHome,
    run,
    gitStatus,
    options: {
      repoRoot: root,
      configHome,
      stateHome,
      mcpToken: 'mcp-token-1234567890',
      model: {
        baseURL: 'http://127.0.0.1:18080/v1',
        model: 'fixture-model',
        apiKey: 'model key "quote" \\ value',
        timeoutMs: 30_000,
      },
      gitCommit: async () => '0123456789abcdef',
      gitStatus,
      serviceUnitTemplate: '# template-source\nEnvironmentFile=@CONFIG_ENV@\nExecStart=@STORE_PATH@/bin/personal-feed serve\nReadWritePaths=@STATE_DIR@\n',
      run,
      now: () => new Date('2026-09-04T00:00:00.000Z'),
    },
  }
}
