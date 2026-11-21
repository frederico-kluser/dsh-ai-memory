/**
 * Plugin configuration: every field is optional and every default works on a
 * standard ai-memory install. Values arrive from the profile patch row
 * (`- id: dsh-ai-memory` / `config:`); invalid values fall back to the default
 * with a warning instead of failing the harness boot.
 * @module config
 */

import { cleanPath } from './paths.js'

/** Which ai-memory tools the model sees. */
export type ToolsMode = 'core' | 'all' | 'none'

/** The raw config a profile may set. */
export interface Config {
  /** Path to the ai-memory executable. Default: discovered (see README). */
  binary?: string
  /** ai-memory data directory, passed as `--data-dir`. Default: ai-memory's own. */
  dataDir?: string
  /** Hook server URL override (`ai-memory hook --server-url`). Default: the install's. */
  serverUrl?: string
  /** Agent label recorded on captured sessions. Default `dsh`. */
  agent?: string
  /** Capture lifecycle events into ai-memory. Default true. */
  capture?: boolean
  /** Capture tool calls (pre and post). Default true. */
  captureTools?: boolean
  /** Report subagent start/stop edges. Default true. */
  captureSubagents?: boolean
  /** Also capture a subagent's child session as its own session. Default false. */
  captureSubagentSessions?: boolean
  /** Claim the pending handoff at session start and add it to the first turn. Default true. */
  handoff?: boolean
  /** Session-start sources that claim a handoff. Default `['startup', 'clear']`. */
  handoffSources?: string[]
  /** After a compaction, re-ground the session with its operator prompts. Default true. */
  anchor?: boolean
  /** Model-facing tools: `core` (default), `all`, `none`, or an explicit list of tool names. */
  tools?: ToolsMode | string[]
  /** Add the ai-memory usage section to the system prompt. Default true. */
  instructions?: boolean
  /** Timeout for one capture hook process, in ms. Default 15000. */
  hookTimeoutMs?: number
  /** Budget for the session-start handoff claim, in ms. Default 6000. */
  startupTimeoutMs?: number
  /** Timeout for one model-facing tool call, in ms. Default 60000. */
  toolTimeoutMs?: number
}

/** The config after defaults and validation. */
export interface ResolvedConfig {
  readonly binary: string | undefined
  readonly dataDir: string | undefined
  readonly serverUrl: string | undefined
  readonly agent: string
  readonly capture: boolean
  readonly captureTools: boolean
  readonly captureSubagents: boolean
  readonly captureSubagentSessions: boolean
  readonly handoff: boolean
  readonly handoffSources: readonly string[]
  readonly anchor: boolean
  readonly tools: ToolsMode | readonly string[]
  readonly instructions: boolean
  readonly hookTimeoutMs: number
  readonly startupTimeoutMs: number
  readonly toolTimeoutMs: number
}

export const DEFAULTS: ResolvedConfig = Object.freeze({
  binary: undefined,
  dataDir: undefined,
  serverUrl: undefined,
  agent: 'dsh',
  capture: true,
  captureTools: true,
  captureSubagents: true,
  captureSubagentSessions: false,
  handoff: true,
  handoffSources: Object.freeze(['startup', 'clear']),
  anchor: true,
  tools: 'core',
  instructions: true,
  hookTimeoutMs: 15_000,
  startupTimeoutMs: 6_000,
  toolTimeoutMs: 60_000,
})

/** ai-memory's agent labels are lowercase words; anything else is refused. */
const AGENT_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

/**
 * Apply defaults and validate. Never throws: a bad field is reported through
 * `warn` and replaced by its default, so a typo cannot stop the harness.
 * @param raw - the config object from the patch row (may be undefined).
 * @param warn - receives one message per rejected field.
 * @returns the resolved config.
 */
export function resolveConfig(raw: unknown, warn: (message: string) => void = () => {}): ResolvedConfig {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: { -readonly [K in keyof ResolvedConfig]: ResolvedConfig[K] } = { ...DEFAULTS }

  const text = (key: keyof Config): string | undefined => {
    const value = input[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') {
      warn(`config.${key} must be a string; ignored`)
      return undefined
    }
    return value
  }
  const flag = (key: keyof Config & keyof ResolvedConfig): void => {
    const value = input[key]
    if (value === undefined || value === null) return
    if (typeof value !== 'boolean') {
      warn(`config.${key} must be true or false; using ${String(DEFAULTS[key])}`)
      return
    }
    ;(out as Record<string, unknown>)[key] = value
  }
  const millis = (key: 'hookTimeoutMs' | 'startupTimeoutMs' | 'toolTimeoutMs', min: number, max: number): void => {
    const value = input[key]
    if (value === undefined || value === null) return
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      warn(`config.${key} must be an integer between ${min} and ${max}; using ${DEFAULTS[key]}`)
      return
    }
    out[key] = value
  }

  const binary = text('binary')
  if (binary !== undefined && cleanPath(binary) !== '') out.binary = cleanPath(binary)
  const dataDir = text('dataDir')
  if (dataDir !== undefined && cleanPath(dataDir) !== '') out.dataDir = cleanPath(dataDir)
  const serverUrl = text('serverUrl')
  if (serverUrl !== undefined && serverUrl.trim() !== '') {
    if (/^https?:\/\/\S+$/i.test(serverUrl.trim())) out.serverUrl = serverUrl.trim().replace(/\/+$/, '')
    else warn('config.serverUrl must be an http(s) URL; ignored')
  }
  const agent = text('agent')
  if (agent !== undefined) {
    if (AGENT_LABEL.test(agent)) out.agent = agent
    else warn(`config.agent "${agent}" is not a valid agent label; using "${DEFAULTS.agent}"`)
  }

  flag('capture')
  flag('captureTools')
  flag('captureSubagents')
  flag('captureSubagentSessions')
  flag('handoff')
  flag('anchor')
  flag('instructions')

  const sources = input['handoffSources']
  if (sources !== undefined && sources !== null) {
    if (Array.isArray(sources) && sources.every(s => typeof s === 'string')) out.handoffSources = Object.freeze([...sources as string[]])
    else warn('config.handoffSources must be a list of strings; using ["startup", "clear"]')
  }

  const tools = input['tools']
  if (tools !== undefined && tools !== null) {
    if (tools === 'core' || tools === 'all' || tools === 'none') out.tools = tools
    else if (Array.isArray(tools) && tools.every(t => typeof t === 'string' && TOOL_NAME.test(t))) out.tools = Object.freeze([...tools as string[]])
    else warn('config.tools must be "core", "all", "none" or a list of tool names; using "core"')
  }

  millis('hookTimeoutMs', 1_000, 300_000)
  millis('startupTimeoutMs', 500, 60_000)
  millis('toolTimeoutMs', 1_000, 600_000)

  return Object.freeze(out)
}
