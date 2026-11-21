/**
 * Structural views of the DeepSeek Harness (DSH) surfaces this plugin uses.
 *
 * The plugin ships with zero runtime dependencies: it imports nothing from
 * `@deepseek-ai/*` at runtime, so it loads from any filesystem location (a
 * profile bundle, a git checkout, an absolute path in a patch row). These
 * interfaces name only the members the plugin reads or calls, checked against
 * the DSH 0.2.1 sources:
 *
 * - `agent/created` (serial, awaited before creation resolves) and
 *   `agent/disposed` (emit) — `packages/core/agent/src/runtime-types.ts`
 * - `agent/pre-step` (waterfall) — same file
 * - `tools/pre-execute` (waterfall) and `tools/result` (emit, frozen final
 *   outcome) — `packages/core/tools/src/events.ts`
 * - `session/event` with `turn/end`, `assistant/message`, `compaction/start`
 *   and `compaction/end` — `packages/core/session/src/types.ts`,
 *   `packages/compaction/compaction/src/types.ts`
 * - `subagent/start` / `subagent/end` — `packages/subagent/subagent`
 * - `ctx.tools.register()`, `ctx.systemPrompt.section()`,
 *   `ctx.workingDirectory.get()` and `ctx.agents.get()`
 * @module types
 */

/** One content block; only `text` blocks are read. */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
}

/** The message source; `kind: 'user'` marks text the operator typed. */
export interface MessageSource {
  readonly kind: string
}

/** A user-role message as DSH logs it (`createUserMessage` shape). */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

/** The session header fields this plugin reads. */
export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
  /** `'subagent'` on a child session spawned by a subagent provider. */
  readonly origin?: string
}

/** A live session. */
export interface Session {
  readonly header: SessionHeader
}

/** The current model selection of an agent. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
}

/** A live agent: its session plus the context-injection seam. */
export interface Agent {
  readonly session: Session
  /** Queue model-facing context for the next pre-step without waking the driver. */
  inject(message: UserMessage): void
  readonly model?: { current(): ModelSelection | undefined }
}

/** Why a session lifecycle began (`SessionStartSource`). */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | (string & {})

export interface AgentCreatedPayload {
  readonly agent: Agent
  readonly source: SessionStartSource
  readonly signal?: AbortSignal
}

export interface AgentDisposedPayload {
  readonly agent: Agent
}

export interface PreStepPayload {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** The pre-step decision is opaque to this plugin: it always delegates. */
export type PreStepDecision = unknown

/** A tool call traversing the pipeline. */
export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** The frozen final outcome of one tool call. */
export interface ToolExecutionResult {
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
}

/** The pre-tool decision is opaque to this plugin: it always delegates. */
export type PreToolDecision = unknown

/** One entry of a session log. */
export interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data: unknown
}

export interface SubagentRunInfo {
  readonly runId: string
  readonly provider: string
  /** The child session id. */
  readonly id: string
  readonly local: boolean
}

export interface SubagentRunEndInfo extends SubagentRunInfo {
  readonly stopReason?: unknown
  readonly lastAssistantMessage?: readonly ContentBlock[]
}

/** The JSON value a tool returns; validated against `output.schema`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A model-facing tool definition (raw JSON-Schema form, as MCP tools register). */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: JsonValue): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

export interface SystemPromptService {
  section(section: PromptSection): () => void
}

export interface WorkingDirectoryService {
  get(session: Session): string
}

export interface AgentsService {
  get(id: string): Agent | undefined
}

export interface Logger {
  debug?(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** The Cordis context members this plugin uses. */
export interface PluginContext {
  on(event: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  effect(execute: () => () => void, label?: string): unknown
  get(name: string): unknown
  readonly logger?: Logger
}
