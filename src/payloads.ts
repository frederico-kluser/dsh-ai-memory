/**
 * Hook payloads in the Claude Code dialect, which `ai-memory hook` parses for
 * every agent. Field names follow Claude Code's hook input schema; the native
 * hook then applies ai-memory's own capture policy (`.ai-memory.toml`
 * allowlists, exclusions) and secret redaction before anything is stored.
 * @module payloads
 */

import type { ContentBlock } from './types.js'

/** Bound one serialized field so a huge tool output cannot flood stdin. */
export const MAX_FIELD_CHARS = 64 * 1024

/** Fields present on every payload. */
export interface BaseFields {
  readonly session_id: string
  /** DSH exposes no transcript file; ai-memory accepts the empty value. */
  readonly transcript_path: ''
  readonly cwd: string
}

export type Payload = Record<string, unknown> & { readonly hook_event_name: string }

/** Concatenate the text blocks of a content list. */
export function blocksToText(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

/** Cut text to `max` characters, marking the cut. */
export function clip(text: string, max: number = MAX_FIELD_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters omitted by dsh-ai-memory]`
}

/**
 * Tool arguments as Claude Code sends `tool_input`: an object. DSH passes the
 * parsed arguments; a string that still holds JSON is parsed, and an
 * oversized value is replaced by a clipped string.
 */
export function toolInput(args: unknown): unknown {
  let value = args
  if (typeof args === 'string') {
    try {
      value = JSON.parse(args) as unknown
    } catch {
      return { raw: clip(args) }
    }
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { raw: '[unserializable tool arguments]' }
  }
  if (serialized === undefined) return {}
  if (serialized.length > MAX_FIELD_CHARS) return { raw: clip(serialized) }
  return value
}

export function base(sessionId: string, cwd: string): BaseFields {
  return { session_id: sessionId, transcript_path: '', cwd }
}

export function sessionStart(fields: BaseFields, source: string, model?: string): Payload {
  return { ...fields, hook_event_name: 'SessionStart', source, ...model !== undefined ? { model } : {} }
}

export function userPrompt(fields: BaseFields, prompt: string): Payload {
  return { ...fields, hook_event_name: 'UserPromptSubmit', prompt: clip(prompt) }
}

export function preToolUse(fields: BaseFields, name: string, args: unknown, callId: string): Payload {
  return { ...fields, hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput(args), tool_use_id: callId }
}

/**
 * A finished tool call. A failure uses Claude Code's `PostToolUseFailure`
 * name, which ai-memory maps to the same post-tool-use observation.
 */
export function postToolUse(fields: BaseFields, name: string, args: unknown, callId: string, response: string, isError: boolean): Payload {
  const common = { ...fields, tool_name: name, tool_input: toolInput(args), tool_use_id: callId }
  if (isError) return { ...common, hook_event_name: 'PostToolUseFailure', error: clip(response), tool_response: clip(response) }
  return { ...common, hook_event_name: 'PostToolUse', tool_response: clip(response) }
}

/**
 * The end of a turn. `reason` is DSH's `TurnEndReason.kind`; a turn that did
 * not complete uses Claude Code's `StopFailure`/`Interrupt` names, which
 * ai-memory records as the same stop.
 */
export function stop(fields: BaseFields, reason: string | undefined): Payload {
  const name = reason === 'error' ? 'StopFailure' : reason === 'aborted' || reason === 'interrupted' ? 'Interrupt' : 'Stop'
  return { ...fields, hook_event_name: name, stop_hook_active: false, ...reason !== undefined ? { stop_reason: reason } : {} }
}

/** A compaction began: `manual` for `/compact`, `auto` for pressure. */
export function preCompact(fields: BaseFields, trigger: 'manual' | 'auto'): Payload {
  return { ...fields, hook_event_name: 'PreCompact', trigger, custom_instructions: '' }
}

/** The agent left the registry: the session is over. */
export function sessionEnd(fields: BaseFields, reason: string): Payload {
  return { ...fields, hook_event_name: 'SessionEnd', reason }
}

/**
 * The agent type DSH subagent seams report: they carry no per-kind label, so
 * the same Claude Code Task default the official bridge uses.
 */
export const SUBAGENT_TYPE = 'general-purpose'

export function subagentStart(fields: BaseFields, agentId: string): Payload {
  return { ...fields, hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: SUBAGENT_TYPE }
}

export function subagentStop(fields: BaseFields, agentId: string, lastAssistantMessage?: string): Payload {
  return {
    ...fields,
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: SUBAGENT_TYPE,
    stop_hook_active: false,
    ...lastAssistantMessage !== undefined && lastAssistantMessage !== '' ? { last_assistant_message: clip(lastAssistantMessage, 8_000) } : {},
  }
}

/** The `--event` value for each hook event name. */
export function cliEventName(hookEventName: string): string {
  switch (hookEventName) {
    case 'SessionStart': return 'session-start'
    case 'UserPromptSubmit': return 'user-prompt-submit'
    case 'PreToolUse': return 'pre-tool-use'
    case 'PostToolUse':
    case 'PostToolUseFailure': return 'post-tool-use'
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt': return 'stop'
    case 'PreCompact': return 'pre-compact'
    case 'SessionEnd': return 'session-end'
    case 'SubagentStart': return 'subagent-start'
    case 'SubagentStop': return 'subagent-stop'
    default: throw new Error(`no ai-memory event for ${hookEventName}`)
  }
}
