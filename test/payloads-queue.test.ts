import test from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/payloads.js'
import { SerialQueues } from '../src/queue.js'

const fields = P.base('session-1', '/repo')

test('payloads use the Claude Code hook dialect', () => {
  assert.deepEqual(P.sessionStart(fields, 'startup', 'deepseek-v4'), {
    session_id: 'session-1', transcript_path: '', cwd: '/repo', hook_event_name: 'SessionStart', source: 'startup', model: 'deepseek-v4',
  })
  assert.equal(P.userPrompt(fields, 'oi').prompt, 'oi')
  const pre = P.preToolUse(fields, 'bash', { command: 'ls' }, 'call-1')
  assert.deepEqual(pre['tool_input'], { command: 'ls' })
  assert.equal(pre['tool_use_id'], 'call-1')
  const ok = P.postToolUse(fields, 'bash', '{"command":"ls"}', 'call-1', 'a\nb', false)
  assert.equal(ok.hook_event_name, 'PostToolUse')
  assert.deepEqual(ok['tool_input'], { command: 'ls' })
  const failed = P.postToolUse(fields, 'bash', {}, 'call-2', 'boom', true)
  assert.equal(failed.hook_event_name, 'PostToolUseFailure')
  assert.equal(failed['error'], 'boom')
  assert.equal(P.preCompact(fields, 'auto')['trigger'], 'auto')
  assert.equal(P.sessionEnd(fields, 'other')['reason'], 'other')
  assert.equal(P.subagentStop(fields, 'child', 'done')['last_assistant_message'], 'done')
})

test('turn endings map to Stop, StopFailure or Interrupt', () => {
  assert.equal(P.stop(fields, 'completed').hook_event_name, 'Stop')
  assert.equal(P.stop(fields, 'error').hook_event_name, 'StopFailure')
  assert.equal(P.stop(fields, 'aborted').hook_event_name, 'Interrupt')
  assert.equal(P.stop(fields, 'interrupted').hook_event_name, 'Interrupt')
  assert.equal(P.stop(fields, undefined).hook_event_name, 'Stop')
})

test('every payload maps to an ai-memory --event value', () => {
  const names = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'Interrupt', 'PreCompact', 'SessionEnd', 'SubagentStart', 'SubagentStop']
  const events = names.map(P.cliEventName)
  assert.deepEqual(events, ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'post-tool-use', 'stop', 'stop', 'stop', 'pre-compact', 'session-end', 'subagent-start', 'subagent-stop'])
  assert.throws(() => P.cliEventName('Nope'))
})

test('huge fields are clipped; odd arguments stay serializable', () => {
  const big = 'x'.repeat(P.MAX_FIELD_CHARS + 10)
  assert.ok((P.userPrompt(fields, big)['prompt'] as string).includes('10 more characters omitted'))
  assert.deepEqual(P.toolInput('not json'), { raw: 'not json' })
  const circular: Record<string, unknown> = {}
  circular['self'] = circular
  assert.deepEqual(P.toolInput(circular), { raw: '[unserializable tool arguments]' })
  assert.ok(typeof (P.toolInput({ blob: big }) as { raw: string }).raw === 'string')
  assert.equal(P.blocksToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
})

test('a session queue runs tasks one at a time, in order, and survives failures', async () => {
  const queues = new SerialQueues()
  const order: string[] = []
  let running = 0
  const task = (label: string, ms: number, fail = false) => async () => {
    running += 1
    assert.equal(running, 1, 'tasks of one session never overlap')
    await new Promise(resolve => setTimeout(resolve, ms))
    order.push(label)
    running -= 1
    if (fail) throw new Error('hook failed')
  }
  queues.enqueue('s', task('start', 30))
  queues.enqueue('s', task('prompt', 1, true))
  queues.enqueue('s', task('tool', 5))
  assert.equal(queues.size('s'), 3)
  await queues.idle('s')
  assert.deepEqual(order, ['start', 'prompt', 'tool'])
  assert.equal(queues.size('s'), 0)
})

test('sessions are independent and a full backlog drops new work', async () => {
  const dropped: string[] = []
  const queues = new SerialQueues(2, key => dropped.push(key))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  assert.ok(queues.enqueue('a', () => gate))
  assert.ok(queues.enqueue('a', async () => {}))
  assert.equal(queues.enqueue('a', async () => {}), false)
  let bRan = false
  queues.enqueue('b', async () => { bRan = true })
  await queues.idle('b')
  assert.ok(bRan, 'a blocked session does not block another')
  release()
  await queues.idle()
  assert.deepEqual(dropped, ['a'])
})
