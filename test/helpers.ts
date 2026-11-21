/**
 * Test doubles: a fake ai-memory executable (a Node script run through
 * `process.execPath`, so the same tests run on Windows, macOS and Linux) and a
 * fake Cordis context that records listeners, effects and registrations.
 * Everything lives under os.tmpdir(); no port is bound, no ai-memory server or
 * DSH home is touched.
 * @module test/helpers
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AiMemoryCli } from '../src/cli.js'
import type { Agent, Logger, PluginContext, PromptSection, Session, ToolDefinition, UserMessage } from '../src/types.js'

/** Walk up from the compiled test file to the package root. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('package root not found')
    dir = parent
  }
  return dir
}

export const FAKE_SCRIPT = join(packageRoot(), 'test', 'fixtures', 'fake-ai-memory.mjs')

export interface Reply {
  stdout?: string
  stderr?: string
  code?: number
  sleepMs?: number
  echoArgv?: boolean
}

export interface Invocation {
  argv: string[]
  cwd: string
  stdin: string
}

/** One fake install: a log of invocations and a table of replies. */
export class FakeAiMemory {
  readonly dir: string
  readonly logPath: string
  readonly repliesPath: string
  readonly cli: AiMemoryCli

  constructor(replies: Record<string, Reply> = {}, options: { dataDir?: string } = {}) {
    this.dir = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-test-'))
    this.logPath = join(this.dir, 'calls.jsonl')
    this.repliesPath = join(this.dir, 'replies.json')
    this.setReplies(replies)
    this.cli = new AiMemoryCli(process.execPath, {
      prefixArgs: [FAKE_SCRIPT],
      dataDir: options.dataDir,
      env: { FAKE_AI_MEMORY_LOG: this.logPath, FAKE_AI_MEMORY_REPLIES: this.repliesPath },
    })
  }

  setReplies(replies: Record<string, Reply>): void {
    writeFileSync(this.repliesPath, JSON.stringify(replies))
  }

  calls(): Invocation[] {
    if (!existsSync(this.logPath)) return []
    return readFileSync(this.logPath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Invocation)
  }

  /** The hook events, in arrival order, with their parsed payloads. */
  hookEvents(): Array<{ event: string; agent: string; payload: Record<string, unknown> }> {
    return this.calls()
      .filter(call => call.argv.includes('hook'))
      .map((call) => {
        const at = (flag: string): string => call.argv[call.argv.indexOf(flag) + 1] ?? ''
        return { event: at('--event'), agent: at('--agent'), payload: JSON.parse(call.stdin) as Record<string, unknown> }
      })
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Wait until `condition` holds or fail after `ms`. */
export async function waitFor(condition: () => boolean, ms = 8_000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

type Listener = (...args: never[]) => unknown

/** A logger that keeps every line. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = []
  info(...args: unknown[]): void { this.lines.push(`info ${args.join(' ')}`) }
  warn(...args: unknown[]): void { this.lines.push(`warn ${args.join(' ')}`) }
  debug(...args: unknown[]): void { this.lines.push(`debug ${args.join(' ')}`) }
}

/** The tools service double: records registrations and their disposal. */
export class FakeTools {
  readonly registered = new Map<string, ToolDefinition>()
  register(definition: ToolDefinition): () => void {
    if (this.registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
    this.registered.set(definition.name, definition)
    return () => { this.registered.delete(definition.name) }
  }
}

export class FakeSystemPrompt {
  readonly sections = new Map<string, PromptSection>()
  section(section: PromptSection): () => void {
    if (this.sections.has(section.name)) throw new Error(`duplicate section ${section.name}`)
    this.sections.set(section.name, section)
    return () => { this.sections.delete(section.name) }
  }
}

/** A live agent double whose injected context is observable. */
export class FakeAgent implements Agent {
  readonly injected: UserMessage[] = []
  readonly session: Session
  readonly model = { current: () => ({ provider: 'deepseek', model: 'deepseek-v4' }) }
  constructor(id: string, cwd: string, origin?: string) {
    this.session = { header: { id, cwd, ...origin !== undefined ? { origin } : {} } }
  }
  inject(message: UserMessage): void { this.injected.push(message) }
}

/**
 * The Cordis context double. `emit` runs listeners like Cordis does for the
 * mode in question: `serial` awaits each, `waterfall` chains `next()`.
 */
export class FakeContext implements PluginContext {
  readonly listeners = new Map<string, Listener[]>()
  readonly effects: Array<() => void> = []
  readonly logger = new MemoryLogger()
  readonly tools = new FakeTools()
  readonly systemPrompt = new FakeSystemPrompt()
  readonly agentsById = new Map<string, FakeAgent>()
  workingDirectory: { get(session: Session): string } | undefined = undefined

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(l => l !== listener)) }
  }

  effect(execute: () => () => void): void {
    this.effects.push(execute())
  }

  get(name: string): unknown {
    switch (name) {
      case 'tools': return this.tools
      case 'systemPrompt': return this.systemPrompt
      case 'agents': return { get: (id: string) => this.agentsById.get(id) }
      case 'workingDirectory': return this.workingDirectory
      default: return undefined
    }
  }

  /** Emit an observation event (`emit` mode). */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => unknown)(...args)
  }

  /** Dispatch a serial event: each listener awaited in order. */
  async serial(event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) await (listener as (...a: unknown[]) => unknown)(...args)
  }

  /** Dispatch a waterfall event ending in `terminal`. */
  async waterfall<T>(event: string, args: unknown[], terminal: () => Promise<T>): Promise<T> {
    const list = this.listeners.get(event) ?? []
    const run = (index: number): Promise<T> => {
      const listener = list[index] as ((...a: unknown[]) => Promise<T>) | undefined
      if (listener === undefined) return terminal()
      return listener(...args, () => run(index + 1))
    }
    return run(0)
  }

  /** Dispose the plugin scope (runs every effect disposer). */
  dispose(): void {
    for (const dispose of this.effects.splice(0).reverse()) dispose()
    this.listeners.clear()
  }

  addAgent(agent: FakeAgent): FakeAgent {
    this.agentsById.set(agent.session.header.id, agent)
    return agent
  }
}

/** A temp directory removed on scope exit. */
export function tempDir(prefix = 'dsh-ai-memory-cwd-'): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
