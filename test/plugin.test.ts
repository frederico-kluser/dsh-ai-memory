import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, CONTEXT_SOURCE, contextMessage, inject, name } from '../src/index.js'
import { CORE_TOOLS, META_TOOL } from '../src/tools.js'
import { SECTION_NAME } from '../src/instructions.js'
import type { ToolExecution, ToolExecutionResult, UserMessage } from '../src/types.js'
import { FakeAgent, FakeAiMemory, FakeContext, tempDir, waitFor, type Reply } from './helpers.js'

const TOOL_LIST = JSON.stringify([
  ...CORE_TOOLS.map(tool => ({ name: tool, description: `${tool}.`, inputSchema: { type: 'object', properties: {} } })),
  { name: 'memory_briefing', description: 'Snapshot.', inputSchema: { type: 'object', properties: {} } },
])
const CLAIMED = JSON.stringify({ status: 'claimed', handoff: { id: 'h1', from_agent: 'claude-code', summary: 'Left off writing tests.', next_steps: ['run them'] } })

function replies(extra: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    call: { stdout: TOOL_LIST },
    'call memory_handoff_accept': { stdout: JSON.stringify({ status: 'none_pending' }) },
    'call memory_handoff_list': { stdout: JSON.stringify({ handoffs: [] }) },
    'call memory_read_session_observations': { stdout: JSON.stringify({ observations: [{ body: 'build the plugin' }, { body: 'now test it' }] }) },
    hook: { stdout: '' },
    ...extra,
  }
}

function setup(extra: Record<string, Reply> = {}, config: Record<string, unknown> = {}) {
  const fake = new FakeAiMemory(replies(extra))
  const ctx = new FakeContext()
  apply(ctx, config, { cli: fake.cli, discovery: { path: process.execPath, source: 'config' } })
  return { fake, ctx }
}

function userMessage(text: string, kind = 'user'): UserMessage {
  return { id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

function toolExec(agent: FakeAgent, callId = 'call-1'): ToolExecution {
  return { callId, name: 'bash', arguments: { command: 'ls' }, agent, signal: new AbortController().signal }
}

test('plugin identity: name, a single required service, the context source', () => {
  assert.equal(name, 'dsh-ai-memory')
  assert.deepEqual(inject, ['tools'])
  const message = contextMessage('hello')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, CONTEXT_SOURCE)
  assert.ok(Object.isFrozen(message))
})

test('a full DSH turn reaches ai-memory in order, with agent=dsh and the session directory', async () => {
  const work = tempDir()
  const { fake, ctx } = setup()
  try {
    const agent = ctx.addAgent(new FakeAgent('s-1', work.path))
    await ctx.serial('agent/created', { agent, source: 'startup' })
    const decision = { kind: 'enter', messages: [] }
    const returned = await ctx.waterfall('agent/pre-step', [{ agent, messages: [userMessage('olá, corrige o bug')], turn: 1, step: 1, signal: new AbortController().signal }], async () => decision)
    assert.equal(returned, decision, 'the pre-step decision passes through untouched')
    // injected context alone is not an operator prompt
    await ctx.waterfall('agent/pre-step', [{ agent, messages: [userMessage('context', 'dsh-ai-memory')], turn: 1, step: 2, signal: new AbortController().signal }], async () => decision)
    const allow = { kind: 'allow' }
    assert.equal(await ctx.waterfall('tools/pre-execute', [toolExec(agent)], async () => allow), allow)
    const result: ToolExecutionResult = { isError: false, content: [{ type: 'text', text: 'file.txt' }] }
    ctx.emit('tools/result', toolExec(agent), result)
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    ctx.emit('session/event', agent.session, { type: 'step/end', data: {} })
    ctx.emit('agent/disposed', { agent })

    await waitFor(() => fake.hookEvents().length === 6, 15_000, 'six hook events')
    const events = fake.hookEvents()
    assert.deepEqual(events.map(e => e.event), ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'stop', 'session-end'])
    for (const event of events) {
      assert.equal(event.agent, 'dsh')
      assert.equal(event.payload['session_id'], 's-1')
      assert.equal(event.payload['cwd'], work.path.replace(/[\\/]$/, ''))
    }
    assert.equal(events[0]?.payload['source'], 'startup')
    assert.equal(events[0]?.payload['model'], 'deepseek-v4')
    assert.equal(events[1]?.payload['prompt'], 'olá, corrige o bug')
    assert.deepEqual(events[2]?.payload['tool_input'], { command: 'ls' })
    assert.equal(events[3]?.payload['tool_response'], 'file.txt')
    assert.equal(events[4]?.payload['stop_reason'], 'completed')
    // the hook ran in the session's directory, so ai-memory resolves the right project
    const hookCalls = fake.calls().filter(call => call.argv.includes('hook'))
    assert.ok(hookCalls.every(call => call.cwd.toLowerCase().includes(work.path.toLowerCase().split(/[\\/]/).at(-1) ?? '')))
  } finally {
    ctx.dispose()
    fake.cleanup()
    work.cleanup()
  }
})

test('the pending handoff is claimed at startup and injected before the first step', async () => {
  const { fake, ctx } = setup({ 'call memory_handoff_accept': { stdout: CLAIMED } })
  try {
    const agent = ctx.addAgent(new FakeAgent('s-2', process.cwd()))
    await ctx.serial('agent/created', { agent, source: 'startup' })
    // serial dispatch: the injection already happened when creation resolves
    assert.equal(agent.injected.length, 1)
    const text = agent.injected[0]?.content[0]?.text ?? ''
    assert.ok(text.includes('ai-memory: pending handoff from previous session'))
    assert.ok(text.includes('Left off writing tests.'))
    assert.equal(agent.injected[0]?.source.kind, 'dsh-ai-memory')
  } finally {
    ctx.dispose()
    fake.cleanup()
  }
})

test('resume does not claim; a disabled handoff never calls the tool', async () => {
  const { fake, ctx } = setup({ 'call memory_handoff_accept': { stdout: CLAIMED } })
  const second = setup({ 'call memory_handoff_accept': { stdout: CLAIMED } }, { handoff: false })
  try {
    const resumed = ctx.addAgent(new FakeAgent('s-3', process.cwd()))
    await ctx.serial('agent/created', { agent: resumed, source: 'resume' })
    assert.equal(resumed.injected.length, 0)
    const off = second.ctx.addAgent(new FakeAgent('s-4', process.cwd()))
    await second.ctx.serial('agent/created', { agent: off, source: 'startup' })
    assert.equal(off.injected.length, 0)
    const claims = [...fake.calls(), ...second.fake.calls()].filter(call => call.argv[1] === 'memory_handoff_accept')
    assert.equal(claims.length, 0)
  } finally {
    ctx.dispose()
    second.ctx.dispose()
    fake.cleanup()
    second.fake.cleanup()
  }
})

test('a slow server cannot hold session creation past the startup budget', async () => {
  const { fake, ctx } = setup({ 'call memory_handoff_accept': { sleepMs: 20_000 } }, { startupTimeoutMs: 700 })
  try {
    const agent = ctx.addAgent(new FakeAgent('s-5', process.cwd()))
    const started = Date.now()
    await ctx.serial('agent/created', { agent, source: 'startup' })
    assert.ok(Date.now() - started < 5_000, 'creation resolved within the budget')
    assert.equal(agent.injected.length, 0)
  } finally {
    ctx.dispose()
    fake.cleanup()
  }
})

test('compaction: PreCompact is captured and the anchor is injected after it', async () => {
  const { fake, ctx } = setup()
  try {
    const agent = ctx.addAgent(new FakeAgent('s-6', process.cwd()))
    await ctx.serial('agent/created', { agent, source: 'startup' })
    ctx.emit('session/event', agent.session, { type: 'compaction/start', data: { compactionId: 'c1', turn: 3 } })
    ctx.emit('session/event', agent.session, { type: 'compaction/end', data: { compactionId: 'c1', turn: 3 } })
    await waitFor(() => agent.injected.length === 1, 15_000, 'the anchor')
    assert.ok(agent.injected[0]?.content[0]?.text?.includes('post-compaction anchor'))
    assert.ok(agent.injected[0]?.content[0]?.text?.includes('build the plugin'))
    const pre = fake.hookEvents().find(e => e.event === 'pre-compact')
    assert.equal(pre?.payload['trigger'], 'auto')
    // a manual /compact is reported as manual; a failed one gets no anchor
    ctx.emit('session/event', agent.session, { type: 'compaction/start', data: { compactionId: 'c2', turn: null, sourceCommandId: 'cmd' } })
    ctx.emit('session/event', agent.session, { type: 'compaction/end', data: { compactionId: 'c2', turn: null, error: 'model failed' } })
    await waitFor(() => fake.hookEvents().filter(e => e.event === 'pre-compact').length === 2, 15_000, 'the manual pre-compact')
    assert.equal(fake.hookEvents().filter(e => e.event === 'pre-compact')[1]?.payload['trigger'], 'manual')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(agent.injected.length, 1)
  } finally {
    ctx.dispose()
    fake.cleanup()
  }
})

test('subagent children: edges reported, child session not captured by default', async () => {
  const { fake, ctx } = setup()
  try {
    const child = ctx.addAgent(new FakeAgent('child-1', process.cwd(), 'subagent'))
    await ctx.serial('agent/created', { agent: child, source: 'startup' })
    ctx.emit('subagent/start', { runId: 'r1', provider: 'in-process', id: 'child-1', local: true })
    await ctx.waterfall('tools/pre-execute', [toolExec(child)], async () => ({ kind: 'allow' }))
    ctx.emit('subagent/end', { runId: 'r1', provider: 'in-process', id: 'child-1', local: true, lastAssistantMessage: [{ type: 'text', text: 'found it' }] })
    ctx.emit('agent/disposed', { agent: child })
    await waitFor(() => fake.hookEvents().length === 2, 15_000, 'the two subagent edges')
    await new Promise(resolve => setTimeout(resolve, 300))
    const events = fake.hookEvents()
    assert.deepEqual(events.map(e => e.event), ['subagent-start', 'subagent-stop'])
    assert.equal(events[1]?.payload['last_assistant_message'], 'found it')
    assert.equal(child.injected.length, 0, 'no handoff is claimed into a child')
  } finally {
    ctx.dispose()
    fake.cleanup()
  }
})

test('an agent first seen mid-session gets a resume session-start before its event', async () => {
  const { fake, ctx } = setup()
  try {
    const agent = ctx.addAgent(new FakeAgent('s-7', process.cwd()))
    await ctx.waterfall('tools/pre-execute', [toolExec(agent)], async () => ({ kind: 'allow' }))
    await waitFor(() => fake.hookEvents().length === 2, 15_000, 'start + tool')
    const events = fake.hookEvents()
    assert.deepEqual(events.map(e => e.event), ['session-start', 'pre-tool-use'])
    assert.equal(events[0]?.payload['source'], 'resume')
  } finally {
    ctx.dispose()
    fake.cleanup()
  }
})

test('DSH shutdown: open sessions get a session-end from a detached process', async () => {
  const { fake, ctx } = setup()
  try {
    const agent = ctx.addAgent(new FakeAgent('s-8', process.cwd()))
    await ctx.serial('agent/created', { agent, source: 'startup' })
    await waitFor(() => fake.hookEvents().length === 1, 15_000, 'session-start')
    ctx.dispose()
    await waitFor(() => fake.hookEvents().some(e => e.event === 'session-end'), 15_000, 'the detached session-end')
    // nothing is captured after disposal
    ctx.emit('tools/result', toolExec(agent), { isError: false, content: [] })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(fake.hookEvents().filter(e => e.event === 'session-end').length, 1)
  } finally {
    fake.cleanup()
  }
})

test('tools: seven core tools plus memory_call, and the usage section', async () => {
  const { fake, ctx } = setup()
  try {
    await waitFor(() => ctx.tools.registered.size === CORE_TOOLS.length + 1, 15_000, 'tool registration')
    assert.deepEqual([...ctx.tools.registered.keys()].sort(), [...CORE_TOOLS, META_TOOL].sort())
    const section = ctx.systemPrompt.sections.get(SECTION_NAME)
    assert.ok(section?.text.includes('memory_query'))
    assert.ok(section?.text.includes('memory_call'))
    ctx.dispose()
    assert.equal(ctx.tools.registered.size, 0, 'disposal unregisters every tool')
  } finally {
    fake.cleanup()
  }
})

test('tools: none keeps the model surface empty; capture can be switched off', async () => {
  const { fake, ctx } = setup({}, { tools: 'none', capture: false })
  try {
    const agent = ctx.addAgent(new FakeAgent('s-9', process.cwd()))
    await ctx.serial('agent/created', { agent, source: 'startup' })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(ctx.tools.registered.size, 0)
    assert.equal(fake.hookEvents().length, 0)
    assert.ok(!ctx.systemPrompt.sections.get(SECTION_NAME)?.text.includes('memory_call'))
  } finally {
    ctx.dispose()
    fake.cleanup()
  }
})

test('no ai-memory executable: the plugin stays inactive and says why', () => {
  const ctx = new FakeContext()
  apply(ctx, {}, { discovery: { error: 'ai-memory executable not found', searched: ['/a', '/b'] } })
  assert.equal(ctx.listeners.size, 0)
  assert.ok(ctx.logger.lines.some(line => line.startsWith('warn') && line.includes('/a, /b')))
})
