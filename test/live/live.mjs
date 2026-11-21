#!/usr/bin/env node
/**
 * Live test: the built plugin (lib/) against a REAL ai-memory executable and
 * server — run by CI on Linux, macOS and Windows, and runnable anywhere:
 *
 *   node test/live/live.mjs
 *
 * Needs a reachable ai-memory server and the executable on PATH (or
 * AI_MEMORY_BIN). The DSH side is a recorded double of the Cordis context, so
 * no harness or model is needed; the real-harness check is scripts/e2e.mjs.
 *
 * The project directory contains a space and non-ASCII characters, and on
 * Windows the plugin is configured with `\\?\` verbatim paths — the inputs
 * that broke the previous DSH integration (ai-memory #2032, #2134, #2203).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../lib/index.js'
import { discoverBinary, processDiscoveryEnv } from '../../lib/binary.js'

let failures = 0
const check = (ok, what, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? ` — ${String(detail).slice(0, 800)}` : ''}`)
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (fn, ms = 30_000) => {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > ms) return undefined
    await sleep(500)
  }
}

const found = discoverBinary(undefined, processDiscoveryEnv())
if ('error' in found) {
  console.error(`Erro: ${found.error} — Solução: put ai-memory on PATH or set AI_MEMORY_BIN`)
  process.exit(2)
}

// A git repository whose path has a space and non-ASCII characters.
const root = mkdtempSync(join(tmpdir(), 'dsh ai-memory ção '))
// A unique name: ai-memory names the project after the repository folder.
const project = join(root, `live project ${Date.now().toString(36)}`)
spawnSync('git', ['init', '-q', project])
writeFileSync(join(project, 'README.md'), '# live fixture\n')
spawnSync('git', ['-C', project, '-c', 'user.email=l@example.invalid', '-c', 'user.name=live', 'add', '.'])
spawnSync('git', ['-C', project, '-c', 'user.email=l@example.invalid', '-c', 'user.name=live', 'commit', '-qm', 'fixture'])

const call = (tool, input) => {
  const result = spawnSync(found.path, ['call', tool, JSON.stringify(input)], { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  try {
    return result.status === 0 ? JSON.parse(result.stdout) : undefined
  } catch {
    return undefined
  }
}

// --- the recorded Cordis context ---
class Context {
  listeners = new Map()
  effects = []
  tools = new Map()
  sections = new Map()
  agents = new Map()
  lines = []
  logger = { info: (...a) => this.lines.push(a.join(' ')), warn: (...a) => this.lines.push(`WARN ${a.join(' ')}`), debug: (...a) => this.lines.push(a.join(' ')) }
  on(event, listener) { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]) }
  effect(execute) { this.effects.push(execute()) }
  get(name) {
    if (name === 'tools') return { register: (d) => { this.tools.set(d.name, d); return () => this.tools.delete(d.name) } }
    if (name === 'systemPrompt') return { section: (s) => { this.sections.set(s.name, s); return () => this.sections.delete(s.name) } }
    if (name === 'agents') return { get: id => this.agents.get(id) }
    return undefined
  }
  emit(event, ...args) { for (const l of this.listeners.get(event) ?? []) l(...args) }
  async serial(event, ...args) { for (const l of this.listeners.get(event) ?? []) await l(...args) }
  async waterfall(event, args, terminal) {
    const list = this.listeners.get(event) ?? []
    const run = i => (list[i] ? list[i](...args, () => run(i + 1)) : terminal())
    return run(0)
  }
  dispose() { for (const d of this.effects.splice(0).reverse()) d(); this.listeners.clear() }
}
class Agent {
  injected = []
  model = { current: () => ({ provider: 'live', model: 'live-model' }) }
  constructor(id) { this.session = { header: { id, cwd: project } } }
  inject(message) { this.injected.push(message) }
}
const message = text => ({ id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const exec = (agent, name, args) => ({ callId: `c-${Math.random()}`, name, arguments: args, agent, signal: new AbortController().signal })

const verbatim = path => (process.platform === 'win32' ? `\\\\?\\${path}` : path)
const config = process.platform === 'win32' ? { binary: verbatim(found.path), ...process.env.AI_MEMORY_DATA_DIR ? { dataDir: verbatim(process.env.AI_MEMORY_DATA_DIR) } : {} } : {}
console.log(`live test · ${process.platform} · ${found.path} · config ${JSON.stringify(config)}`)
console.log(`  project ${project}`)

const ctx = new Context()
apply(ctx, config)
check(ctx.listeners.size >= 8, 'the plugin activated and registered its listeners', ctx.lines.join('\n'))

// --- session 1: a turn with a tool call, then the agent goes away ---
const s1 = `live-${Date.now()}-1`
const a1 = new Agent(s1)
ctx.agents.set(s1, a1)
await ctx.serial('agent/created', { agent: a1, source: 'startup' })
await ctx.waterfall('agent/pre-step', [{ agent: a1, messages: [message('live: refactor the parser — ação "quoted" C:\\path\\x')], turn: 1, step: 1, signal: new AbortController().signal }], async () => ({ kind: 'enter', messages: [] }))
const e1 = exec(a1, 'bash', { command: 'ls -la' })
await ctx.waterfall('tools/pre-execute', [e1], async () => ({ kind: 'allow' }))
ctx.emit('tools/result', e1, { isError: false, content: [{ type: 'text', text: 'README.md' }] })
ctx.emit('session/event', a1.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
ctx.emit('agent/disposed', { agent: a1 })

const wanted = ['user-prompt', 'pre-tool-use', 'post-tool-use', 'stop']
const kinds = await until(() => {
  const read = call('memory_read_session_observations', { session_id: s1, order: 'asc', limit: 100 })
  const list = (read?.observations ?? []).map(o => o.kind)
  return wanted.every(k => list.includes(k)) ? list : undefined
}, 45_000)
check(kinds !== undefined, `ai-memory recorded ${wanted.join(', ')}`, JSON.stringify(call('memory_read_session_observations', { session_id: s1, order: 'asc', limit: 100 })))
const prompt = (call('memory_read_session_observations', { session_id: s1, kinds: ['user-prompt'], order: 'asc', limit: 5 })?.observations ?? [])[0]
check(typeof prompt?.body === 'string' && prompt.body.includes('ação "quoted" C:\\path\\x'), 'the prompt arrived byte-for-byte (quotes, backslashes, UTF-8)', JSON.stringify(prompt))

// ai-memory stores a canonical id (a UUID derived from the native one), so the
// briefing is matched by project: this fresh repository holds only our sessions.
const projectSessions = () => (call('memory_briefing', { recent_sessions_limit: 50 })?.recent_sessions ?? []).filter(x => x.cwd === project)
const session = await until(() => {
  const list = projectSessions()
  return list.length === 1 && list[0].ended === true ? list[0] : undefined
}, 45_000)
check(session !== undefined, 'the session ended by itself (SessionEnd delivered)', JSON.stringify(projectSessions()))
check(session?.agent_kind === 'dsh', 'the session is attributed to agent dsh', JSON.stringify(session))

const handoff = await until(() => (call('memory_handoff_list', {})?.handoffs ?? []).find(h => h.from_agent === 'dsh'), 45_000)
check(handoff !== undefined, 'ai-memory wrote an automatic handoff from agent dsh', JSON.stringify(call('memory_handoff_list', {})))

// --- session 2: the handoff is claimed and injected at startup ---
const s2 = `live-${Date.now()}-2`
const a2 = new Agent(s2)
ctx.agents.set(s2, a2)
await ctx.serial('agent/created', { agent: a2, source: 'startup' })
const injected = a2.injected[0]?.content?.[0]?.text ?? ''
check(injected.includes('ai-memory: pending handoff from previous session'), 'the handoff was injected before the first step', injected || ctx.lines.join('\n'))
check(injected.includes('refactor the parser'), 'the injected handoff carries the previous session\'s request', injected)
check(!(call('memory_handoff_list', {})?.handoffs ?? []).some(h => h.id === handoff?.id), 'the claimed handoff is single-use (no longer open)')

// --- tools: registered from the live server and callable ---
await until(() => ctx.tools.size > 0, 20_000)
check(ctx.tools.has('memory_query') && ctx.tools.has('memory_call'), 'core tools + memory_call registered from the live listing', [...ctx.tools.keys()].join(', '))
const listTool = ctx.tools.get('memory_handoff_list')
const listed = listTool ? await listTool.execute({}, exec(a2, 'memory_handoff_list', {})) : undefined
check(typeof listed?.text === 'string' && listed.text.includes('handoffs'), 'a native memory tool call round-trips', JSON.stringify(listed))
const metaTool = ctx.tools.get('memory_call')
const brief = metaTool ? await metaTool.execute({ tool: 'memory_briefing', arguments: { recent_sessions_limit: 1 } }, exec(a2, 'memory_call', {})) : undefined
check(typeof brief?.text === 'string' && brief.text.length > 0, 'memory_call reaches a folded tool', JSON.stringify(brief))

// --- compaction: PreCompact captured, anchor injected with this session's prompts ---
await ctx.waterfall('agent/pre-step', [{ agent: a2, messages: [message('live: second session prompt')], turn: 1, step: 1, signal: new AbortController().signal }], async () => ({ kind: 'enter', messages: [] }))
ctx.emit('session/event', a2.session, { type: 'compaction/start', data: { compactionId: 'k1', turn: 1 } })
await until(() => (call('memory_read_session_observations', { session_id: s2, kinds: ['user-prompt'], order: 'asc', limit: 5 })?.observations ?? []).length > 0, 30_000)
ctx.emit('session/event', a2.session, { type: 'compaction/end', data: { compactionId: 'k1', turn: 1 } })
const anchor = await until(() => a2.injected.find(m => m.content[0].text.includes('post-compaction anchor')), 30_000)
check(anchor?.content[0].text.includes('live: second session prompt'), 'the post-compaction anchor lists this session\'s prompts', anchor?.content[0].text ?? ctx.lines.join('\n'))
const preCompact = await until(() => (call('memory_read_session_observations', { session_id: s2, order: 'asc', limit: 100 })?.observations ?? []).some(o => o.kind === 'pre-compact'), 30_000)
check(preCompact === true, 'ai-memory recorded pre-compact')

// --- shutdown: the open session is closed by a detached process ---
ctx.dispose()
const closed = await until(() => {
  const list = projectSessions()
  return list.length === 2 && list.every(x => x.ended === true)
}, 45_000)
check(closed === true, 'plugin disposal closed the open session', JSON.stringify(projectSessions()))

const warnings = ctx.lines.filter(line => line.startsWith('WARN'))
check(warnings.length === 0, 'no warnings logged', warnings.join('\n'))

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nLIVE OK' : `\nLIVE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
