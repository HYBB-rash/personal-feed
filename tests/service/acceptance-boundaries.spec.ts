import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { BOUNDARY_CASES, FIXTURE_FACTS, FIXTURE_REQUEST, RECOVERY_URL, prepareBoundaryFixture, startBoundaryService } from '../fixtures/v2-boundaries.ts'

const reasons = {
  'A11-1': ['observation_failed', '获取来源失败'],
  'A11-2': ['partial_observation', '仅完成部分来源观察'],
  'A11-3': ['material_insufficient', '来源正文不足'],
} as const

describe('A10/A11 isolated serve → HTTP MCP → application → model decoder / Python adapter', () => {
  it.each(BOUNDARY_CASES)('%s preserves the actual boundary and recovers through the same service', async scenario => {
    const fixture = await prepareBoundaryFixture(scenario)
    let service: Awaited<ReturnType<typeof startBoundaryService>> | undefined
    const client = new Client({ name: 'boundary-acceptance', version: '1' })
    try {
      const preparedContext = await readFile(join(fixture.stateDir, 'personal-context.json'), 'utf8')
      expect(JSON.parse(preparedContext)).toEqual({ schemaVersion: 1, generation: 1, facts: FIXTURE_FACTS })
      service = await startBoundaryService(fixture)
      await client.connect(new StreamableHTTPClientTransport(new URL(`${service.origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${fixture.environment.PERSONAL_FEED_MCP_TOKEN}` } },
      }))
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'list_saved', 'observe_context', 'process_feedback', 'record_feedback', 'request',
      ])
      const result = await client.callTool({ name: 'request', arguments: { currentText: FIXTURE_REQUEST } })
      const readable = (result.content as Array<{ text: string }>).map(block => block.text).join('\n')
      if (scenario === 'A11-5') {
        expect(await readFile(join(fixture.stateDir, 'candidates.jsonl'), 'utf8')).toBe('{invalid storage\n')
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toBeUndefined()
        expect(readable).toContain('本次调用未完成')
      } else {
        expect(result.isError).not.toBe(true)
        if (scenario === 'A10-1' || scenario === 'A10-2') {
          expect(result.structuredContent).toEqual({ status: 'business_empty' })
          expect(readable).toContain('暂时没有')
        } else if (scenario === 'A11-4') {
          expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'judgement_execution' })
          expect(readable).toContain('未完成')
        } else {
          expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'source_window', reason: reasons[scenario][0] })
          expect(readable).toContain(reasons[scenario][1])
        }
      }
      if (scenario.startsWith('A11')) expect(readable).not.toContain('暂时没有')
      const observedContext = JSON.parse(await readFile(join(fixture.stateDir, 'personal-context.json'), 'utf8'))
      expect(observedContext).toMatchObject({ schemaVersion: 1, facts: FIXTURE_FACTS })
      expect(observedContext.generation).toBeGreaterThanOrEqual(1)
      const observations = await fixture.observations()
      expect(observations).toEqual([{ mode: scenario, kind: ['A11-1', 'A11-2'].includes(scenario) ? 'incomplete' : 'complete', candidates: ['A10-1', 'A11-1'].includes(scenario) ? 0 : 1, ...(scenario === 'A11-2' ? { snapshotFailedAfterMaterial: true } : {}) }])
      expect(fixture.modelEvents.filter(event => event.operation === 'context')).toEqual([{ operation: 'context', mode: scenario, outcome: 'success' }])
      const judgments = fixture.modelEvents.filter(event => event.operation === 'judge')
      expect(judgments).toEqual(scenario === 'A10-2' ? [{ operation: 'judge', mode: scenario, outcome: 'not_qualified' }]
        : scenario === 'A11-4' ? [{ operation: 'judge', mode: scenario, outcome: 'http_503' }] : [])
      const ledger = await readFile(join(fixture.stateDir, 'candidates.jsonl'), 'utf8').catch(() => '')
      if (scenario === 'A10-2') expect(ledger).toContain('not_qualified')
      else if (scenario !== 'A11-5') expect(ledger).toBe('')

      await fixture.recover()
      const recovered = await client.callTool({ name: 'request', arguments: { currentText: FIXTURE_REQUEST } })
      expect(recovered.isError).not.toBe(true)
      expect(recovered.structuredContent).toEqual({ status: 'one_link', url: RECOVERY_URL })
      expect((await fixture.observations()).at(-1)).toEqual({ mode: 'recovered', kind: 'complete', candidates: 1 })
      expect(fixture.modelEvents.at(-1)).toEqual({ operation: 'judge', mode: 'recovered', outcome: 'qualified' })
      const logs = service.logs.join('')
      expect(logs).not.toContain(FIXTURE_REQUEST)
      expect(logs).not.toContain('Controlled fixture source text')
      expect(logs).not.toContain('https://x.com/')
      expect(logs).not.toContain(fixture.environment.PERSONAL_FEED_MCP_TOKEN)
      expect(logs).not.toContain(fixture.environment.PERSONAL_FEED_MODEL_API_KEY)
    } finally {
      await client.close()
      try { await service?.close() } finally { await fixture.close() }
    }
  }, 20_000)
})
