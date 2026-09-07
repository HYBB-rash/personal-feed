import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PersonalFeedInputError } from './errors.ts'

export interface OpenAICompatibleConfig {
  readonly baseURL: string
  readonly model: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly responseFormat?: 'json_content' | 'strict_tool'
}

export function resolveStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.XDG_STATE_HOME?.trim()
  const configuredHome = environment.HOME?.trim()
  const home = configuredHome === undefined || configuredHome === '' ? homedir() : configuredHome
  return resolve(root === undefined || root === '' ? join(home, '.local', 'state') : root, 'personal-feed')
}

export function parseOpenAICompatibleConfig(input: Readonly<Record<string, unknown>>): OpenAICompatibleConfig {
  const keys = Object.keys(input)
  if (![4, 5].includes(keys.length) || keys.some(key => !['baseURL', 'model', 'apiKey', 'timeoutMs', 'responseFormat'].includes(key))) {
    throw new PersonalFeedInputError('model config requires baseURL, model, apiKey and timeoutMs; responseFormat is optional')
  }
  if ('responseFormat' in input && input.responseFormat !== 'json_content' && input.responseFormat !== 'strict_tool') {
    throw new PersonalFeedInputError('responseFormat must be json_content or strict_tool')
  }
  const baseURL = requiredString(input.baseURL, 'baseURL').replace(/\/+$/u, '')
  const model = requiredString(input.model, 'model')
  const apiKey = requiredString(input.apiKey, 'apiKey')
  const timeoutMs = input.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300_000) {
    throw new PersonalFeedInputError('timeoutMs must be an integer between 1 and 300000')
  }
  let parsed: URL
  try { parsed = new URL(baseURL) } catch { throw new PersonalFeedInputError('baseURL must be an absolute HTTP URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PersonalFeedInputError('baseURL must be an absolute HTTP URL')
  }
  return Object.freeze({ baseURL, model, apiKey, timeoutMs: timeoutMs as number,
    ...('responseFormat' in input ? { responseFormat: input.responseFormat as 'json_content' | 'strict_tool' } : {}) })
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new PersonalFeedInputError(`${field} must be a non-empty string`)
  return value.trim()
}
