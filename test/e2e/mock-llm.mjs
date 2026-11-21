/**
 * Keyless, deterministic model for the dsh-ai-memory end-to-end test.
 *
 * Loaded by DSH as an ordinary plugin row. It registers the `e2e-mock`
 * provider and plays a two-step script per turn: one tool call, then a final
 * answer that reports what the harness actually delivered to the model —
 * whether the ai-memory handoff block was in the messages, whether the
 * ai-memory system-prompt section and tools were offered — so the test can
 * assert the whole pipeline from the outside.
 *
 * `LlmAdapter` is resolved from the DSH checkout named by
 * DSH_AI_MEMORY_E2E_DSH_ROOT, so the class is the one the running harness
 * loaded (same module URL, same identity).
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_AI_MEMORY_E2E_DSH_ROOT
if (!root) throw new Error('mock-llm: DSH_AI_MEMORY_E2E_DSH_ROOT is not set')
const requireFromCli = createRequire(join(root, 'apps', 'cli', 'package.json'))
const { LlmAdapter, ReasoningEffortId, ToolCallId, CONTEXT_WINDOW_EXCEEDED_CODE } = await import(pathToFileURL(requireFromCli.resolve('@deepseek-ai/dsh-llm')).href)

const OFF = ReasoningEffortId('off')
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_COMMAND = process.platform === 'win32' ? "Write-Output 'E2E_TOOL_ROUND_TRIP'" : 'printf E2E_TOOL_ROUND_TRIP'
const SLOW_SHELL_COMMAND = process.platform === 'win32' ? "Start-Sleep -Seconds 4; Write-Output 'E2E_TOOL_ROUND_TRIP'" : 'sleep 4; printf E2E_TOOL_ROUND_TRIP'

function texts(messages, role) {
  return messages
    .filter(message => role === undefined || message.role === role)
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function* say(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* callTool(name, args) {
  const id = ToolCallId(`e2e-${name}-${Date.now()}`)
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

let overflowed = false
const CHECKPOINT = [
  '## Primary Request and Intent', '- end-to-end check of dsh-ai-memory', '',
  '## Key Technical Concepts', '- (none)', '',
  '## Files and Code', '- README.md', '',
  '## Errors and Fixes', '- (none)', '',
  '## Pending Jobs', '- (none)', '',
  '## Current Work', '- verifying the post-compaction anchor', '',
  '## Next Step', '- run one more tool call', '',
  '## Critical Context', '- (none)',
].join('\n')

class E2eAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF } }
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const userText = texts(messages, 'user')
    const system = typeof options.system === 'string' ? options.system : texts(messages, 'system')
    const last = messages.at(-1)
    // The compaction summarizer appends its directive as the final user message
    // (`purpose: 'compaction'` on newer DSH): answer with a checkpoint.
    if (options.purpose === 'compaction' || texts(messages.slice(-1)).includes('compaction engine')) {
      yield * say(CHECKPOINT)
      return
    }
    // E2E_COMPACT: report one provider-confirmed context overflow, which makes
    // dsh-compaction-basic compact the session and retry the step.
    if (!overflowed && last?.role !== 'tool' && userText.includes('E2E_COMPACT')) {
      overflowed = true
      yield { type: 'finish', reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'context length exceeded (e2e forced overflow)' } } }
      return
    }
    if (last?.role === 'tool') {
      const offered = (options.tools ?? []).map(tool => tool.name)
      const report = {
        handoff: userText.includes('ai-memory: pending handoff from previous session') ? 'seen' : 'absent',
        anchor: userText.includes('ai-memory: post-compaction anchor') ? 'seen' : 'absent',
        section: system.includes('ai-memory (persistent project memory)') ? 'yes' : 'no',
        tools: offered.includes('memory_query') && offered.includes('memory_call') ? 'yes' : 'no',
        result: texts([last]).slice(0, 300),
      }
      yield * say(`E2E_REPORT ${JSON.stringify(report)}`)
      return
    }
    // After the compaction, a slow tool: the anchor is fetched while it runs and
    // lands at the next step boundary, which the final report then inspects.
    if (userText.includes('E2E_COMPACT')) {
      yield * callTool(SHELL_TOOL, { command: SLOW_SHELL_COMMAND, description: 'Give the anchor time to land.' })
      return
    }
    if (userText.includes('E2E_MEMORY_TOOL')) {
      yield * callTool('memory_handoff_list', {})
      return
    }
    yield * callTool(SHELL_TOOL, { command: SHELL_COMMAND, description: 'Prove the tool round trip.' })
  }
}

export const name = 'dsh-ai-memory-e2e-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['e2e-mock'], new E2eAdapter())
}
