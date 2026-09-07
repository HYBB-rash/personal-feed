import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { BOUNDARY_CASES, FIXTURE_FACTS, FIXTURE_REQUEST, RECOVERY_URL, prepareBoundaryFixture, startBoundaryService } from '../fixtures/v2-boundaries.ts'

const expected = {
  partial_body_shortage: { status: 'one_link', url: 'https://x.com/fixture/status/102', limitations: ['material_insufficient'] },
  single_judgement_failure: { status: 'one_link', url: 'https://x.com/fixture/status/102', limitations: ['judgement_incomplete'] },
  whole_source_failure: { status: 'incomplete', stage: 'source_window', reason: 'observation_failed' },
  all_body_insufficient: { status: 'incomplete', stage: 'source_window', reason: 'material_insufficient' },
  whole_judgement_failure: { status: 'incomplete', stage: 'judgement_execution' },
  empty_context_direct_discovery: { status: 'one_link', url: 'https://x.com/fixture/status/101' },
} as const

const firstObservationCounts = {
  partial_body_shortage: 2,
  single_judgement_failure: 2,
  whole_source_failure: 0,
  all_body_insufficient: 1,
  whole_judgement_failure: 1,
  empty_context_direct_discovery: 1,
} as const

const firstJudgements = {
  partial_body_shortage: ['qualified'],
  single_judgement_failure: ['http_503', 'qualified'],
  whole_source_failure: [],
  all_body_insufficient: [],
  whole_judgement_failure: ['http_503'],
  empty_context_direct_discovery: ['qualified'],
} as const

describe('V0 isolated serve -> HTTP MCP -> application -> model decoder / Python adapter', () => {
  it.each(BOUNDARY_CASES)('%s preserves the actual boundary and recovers through the same service', async scenario => {
    const fixture = await prepareBoundaryFixture(scenario)
    let service: Awaited<ReturnType<typeof startBoundaryService>> | undefined
    const client = new Client({ name: 'boundary-acceptance', version: '1' })
    try {
      const initialFacts = scenario === 'empty_context_direct_discovery' ? [] : FIXTURE_FACTS
      expect(JSON.parse(await readFile(join(fixture.stateDir, 'personal-context.json'), 'utf8')))
        .toEqual({ schemaVersion: 1, generation: 1, facts: initialFacts })
      service = await startBoundaryService(fixture)
      await client.connect(new StreamableHTTPClientTransport(new URL(`${service.origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${fixture.environment.PERSONAL_FEED_MCP_TOKEN}` } },
      }))
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'list_saved', 'observe_context', 'process_feedback', 'record_feedback', 'request',
      ])

      const result = await client.callTool({ name: 'request', arguments: { currentText: FIXTURE_REQUEST } })
      const readable = (result.content as Array<{ text: string }>).map(block => block.text).join('\n')
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual(expected[scenario])
      if (scenario.includes('failure') || scenario === 'all_body_insufficient') expect(readable).not.toContain('暂时没有')
      if (scenario === 'partial_body_shortage') expect(readable).toContain('部分正文不足')
      if (scenario === 'single_judgement_failure') expect(readable).toContain('部分内容判断未完成')

      const observedContext = JSON.parse(await readFile(join(fixture.stateDir, 'personal-context.json'), 'utf8'))
      expect(observedContext).toEqual({ schemaVersion: 1, generation: 1, facts: initialFacts })
      expect(await fixture.observations()).toEqual([{
        mode: scenario,
        kind: scenario === 'whole_source_failure' ? 'incomplete' : 'complete',
        occurrences: firstObservationCounts[scenario],
      }])
      expect(fixture.modelEvents.filter(event => event.operation === 'context')).toEqual([])
      expect(fixture.modelEvents.filter(event => event.operation === 'judge').map(event => event.outcome))
        .toEqual(firstJudgements[scenario])

      await fixture.recover()
      const recovered = await client.callTool({ name: 'request', arguments: { currentText: FIXTURE_REQUEST } })
      expect(recovered.isError).not.toBe(true)
      expect(recovered.structuredContent).toEqual({ status: 'one_link', url: RECOVERY_URL })
      expect((await fixture.observations()).at(-1)).toEqual({ mode: 'recovered', kind: 'complete', occurrences: 1 })
      expect(fixture.modelEvents.at(-1)).toEqual({ operation: 'judge', mode: 'recovered', outcome: 'qualified' })
      const logs = service.logs.join('')
      expect(logs).not.toContain(FIXTURE_REQUEST)
      expect(logs).not.toContain('Controlled source text')
      expect(logs).not.toContain('https://x.com/')
      expect(logs).not.toContain(fixture.environment.PERSONAL_FEED_MCP_TOKEN)
      expect(logs).not.toContain(fixture.environment.PERSONAL_FEED_MODEL_API_KEY)
    } finally {
      await client.close()
      try { await service?.close() } finally { await fixture.close() }
    }
  }, 20_000)
})
