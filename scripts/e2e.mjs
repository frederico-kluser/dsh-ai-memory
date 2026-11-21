#!/usr/bin/env node
/**
 * End-to-end test against a REAL DeepSeek Harness and a REAL ai-memory server.
 *
 *   node scripts/e2e.mjs [--dsh-root <checkout>] [--work <dir>] [--keep]
 *                        [--install github:frederico-kluser/dsh-ai-memory#v0.1.0]
 *
 * With --install, the published package is installed into the isolated
 * profile with `dsh plugin add` and mounted by its bundle layer; without it,
 * this checkout's lib/ is mounted by a patch row.
 *
 * It never touches ~/.dsh or an existing project: DSH runs from an isolated
 * DSH_HOME with a keyless mock model, inside a fresh git repository, and the
 * ai-memory project it creates is purged at the end (unless --keep).
 *
 * Session 1 proves capture: start, prompt, a shell tool call, the turn stop
 * and the session end all reach ai-memory as agent `dsh`, the session closes
 * by itself, and ai-memory writes its automatic handoff.
 * Session 2 proves delivery: dsh-ai-memory claims that handoff at startup and
 * the model sees it in its first turn, together with the ai-memory
 * system-prompt section and tools; a native memory tool call round-trips.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverBinary, processDiscoveryEnv } from '../lib/binary.js'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const keep = args.includes('--keep')

let failures = 0
const pass = (what) => console.log(`  PASS  ${what}`)
const fail = (what, detail = '') => {
  failures += 1
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
}
const check = (ok, what, detail) => (ok ? pass(what) : fail(what, detail))
const die = (what, solution) => {
  console.error(`Erro: ${what} — Solução: ${solution}`)
  process.exit(2)
}

// --- prerequisites ---
const dshRoot = resolve(option('--dsh-root') ?? process.env.DSH_AI_MEMORY_E2E_DSH_ROOT
  ?? [join(homedir(), 'Projects', 'deepseek-harness'), '/Volumes/Ext2TB/Projects/deepseek-harness'].find(dir => existsSync(join(dir, 'apps', 'cli', 'lib', 'bin.js')))
  ?? '')
const dshBin = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')
if (!existsSync(dshBin)) die(`DSH CLI not found at ${dshBin}`, 'pass --dsh-root <deepseek-harness checkout with apps/cli built>')
if (!existsSync(join(repo, 'lib', 'index.js'))) die('lib/index.js is missing', 'run `npm run build` first')

const found = discoverBinary(undefined, processDiscoveryEnv())
if ('error' in found) die(found.error, 'install ai-memory or set AI_MEMORY_BIN')
const aiMemory = (argv, cwd) => {
  const result = spawnSync(found.path, argv, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
const callJson = (tool, input, cwd) => {
  const result = aiMemory(['call', tool, JSON.stringify(input)], cwd)
  if (result.code !== 0) return { error: `${tool} exited ${result.code}: ${result.stderr.slice(-400)}` }
  try {
    return { value: JSON.parse(result.stdout) }
  } catch {
    return { error: `${tool} did not return JSON: ${result.stdout.slice(0, 300)}` }
  }
}
if (aiMemory(['call', 'memory_status', '{}'], homedir()).code !== 0) die('the ai-memory server does not answer', 'start it (`ai-memory serve` or its service) and retry')

// --- isolated workspace ---
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const work = resolve(option('--work') ?? join(repo, '.e2e'))
const project = join(work, `dsh-ai-memory-e2e-${stamp}`)
const dshHome = join(work, `dsh-home-${stamp}`)
mkdirSync(project, { recursive: true })
mkdirSync(dshHome, { recursive: true })
const git = (...argv) => spawnSync('git', argv, { cwd: project, encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 'e2e@example.invalid')
git('config', 'user.name', 'e2e')
writeFileSync(join(project, 'README.md'), '# dsh-ai-memory e2e fixture\n')
git('add', '.')
git('commit', '-qm', 'fixture')

// --install <spec>: test the distributed package instead of this checkout —
// `dsh plugin add <spec>` into the isolated profile, so the bundle layer (not
// a patch row) mounts the plugin, exactly as a user install does.
const installSpec = option('--install')
if (installSpec !== undefined) {
  const added = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', installSpec], {
    cwd: project, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    env: { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1' },
  })
  if (added.status !== 0) die(`dsh plugin add ${installSpec} failed (exit ${added.status}): ${(added.stderr || added.stdout).slice(-800)}`, 'check pnpm and network access to GitHub')
  const dumped = spawnSync(process.execPath, [dshBin, '--profile', 'headless', '--dump-config'], {
    cwd: project, encoding: 'utf8', timeout: 120_000, windowsHide: true,
    env: { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1' },
  })
  console.log(`  installed ${installSpec} into the isolated headless profile`)
  check(dumped.status === 0 && /dsh-ai-memory/.test(dumped.stdout), 'the composed headless profile mounts the dsh-ai-memory bundle row', (dumped.stderr || dumped.stdout).slice(-600))
}

const patchPath = join(work, `e2e-${stamp}.patch.yml`)
const yamlPath = (path) => `'${path.replaceAll("'", "''")}'`
writeFileSync(patchPath, [
  '# dsh-ai-memory e2e overlay: keyless mock model + the plugin under test.',
  '- id: agent-default-model',
  '  config:',
  '    provider: e2e-mock',
  '    model: e2e-mock',
  '- insert:',
  '    - id: dsh-ai-memory-e2e-mock-llm',
  `      name: ${yamlPath(join(repo, 'test', 'e2e', 'mock-llm.mjs'))}`,
  ...installSpec === undefined ? ['    - id: dsh-ai-memory', `      name: ${yamlPath(join(repo, 'lib', 'index.js'))}`] : [],
  '',
].join('\n'))

const runDsh = (task, extra = []) => {
  const result = spawnSync(process.execPath, [dshBin, '--profile', 'headless', '--patch', patchPath, '--json', ...extra, task], {
    cwd: project,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, DSH_HOME: dshHome, DSH_AI_MEMORY_E2E_DSH_ROOT: dshRoot, NO_COLOR: '1' },
  })
  const events = (result.stdout ?? '').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return { type: 'text', line }
    }
  })
  return {
    code: result.status,
    stderr: result.stderr ?? '',
    sessionId: events.find(e => e.type === 'session')?.sessionId,
    final: events.filter(e => e.type === 'final').at(-1)?.text ?? '',
  }
}
const sleep = (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const report = (final) => {
  const at = final.indexOf('E2E_REPORT ')
  if (at < 0) return undefined
  try {
    return JSON.parse(final.slice(at + 'E2E_REPORT '.length))
  } catch {
    return undefined
  }
}
const observationKinds = async (sessionId, wanted) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const read = callJson('memory_read_session_observations', { session_id: sessionId, order: 'asc', limit: 200 }, project)
    const list = read.value?.observations ?? []
    const kinds = list.map(o => o.kind)
    if (wanted.every(kind => kinds.includes(kind))) return { kinds, list }
    if (attempt === 29) return { kinds, list, error: read.error }
    await sleep(1_000)
  }
  return { kinds: [], list: [] }
}

console.log(`dsh-ai-memory e2e · DSH ${dshRoot} · ai-memory ${found.path}`)
console.log(`  project ${project}`)

// --- session 1: capture ---
console.log('\nsession 1 — capture')
const first = runDsh('E2E first prompt: list the files of this repository')
check(first.code === 0, 'dsh headless finished', `exit ${first.code}: ${first.stderr.slice(-600)}`)
check(typeof first.sessionId === 'string', 'the session id was reported', JSON.stringify(first))
const firstReport = report(first.final)
check(firstReport !== undefined && firstReport.result.includes('E2E_TOOL_ROUND_TRIP'), 'the shell tool round-tripped', first.final)
check(firstReport?.section === 'yes', 'the ai-memory system-prompt section reached the model')
check(firstReport?.tools === 'yes', 'the ai-memory tools were offered to the model')

const wanted = ['user-prompt', 'pre-tool-use', 'post-tool-use', 'stop']
const seen = first.sessionId ? await observationKinds(first.sessionId, wanted) : { kinds: [], list: [] }
for (const kind of wanted) check(seen.kinds.includes(kind), `ai-memory recorded ${kind}`, `kinds: ${seen.kinds.join(', ')}${seen.error ? ` (${seen.error})` : ''}`)

// ai-memory keeps a canonical id (a UUID derived from DSH's), so sessions are
// matched by project: the fresh fixture repository holds only this test's sessions.
const projectSessions = () => (callJson('memory_briefing', { recent_sessions_limit: 50 }, project).value?.recent_sessions ?? [])
  .filter(s => typeof s.cwd === 'string' && s.cwd.includes(`dsh-ai-memory-e2e-${stamp}`))
let firstSession
for (let attempt = 0; attempt < 30 && firstSession === undefined; attempt++) {
  const list = projectSessions()
  if (list.length === 1 && list[0].ended === true) firstSession = list[0]
  else await sleep(1_000)
}
check(firstSession !== undefined, 'the session ended by itself (SessionEnd delivered, no finalize-session needed)', JSON.stringify(projectSessions()))
check(firstSession?.agent_kind === 'dsh', 'the session is attributed to agent dsh', JSON.stringify(firstSession))

let handoffId
for (let attempt = 0; attempt < 30 && handoffId === undefined; attempt++) {
  const list = callJson('memory_handoff_list', {}, project)
  handoffId = (list.value?.handoffs ?? []).find(h => h.from_agent === 'dsh')?.id
  if (handoffId === undefined) await sleep(1_000)
}
check(handoffId !== undefined, 'ai-memory wrote the automatic handoff for the next session')

// --- session 2: delivery ---
console.log('\nsession 2 — delivery')
const second = runDsh('E2E_MEMORY_TOOL second session: where did we leave off?')
check(second.code === 0, 'dsh headless finished', `exit ${second.code}: ${second.stderr.slice(-600)}`)
const secondReport = report(second.final)
check(secondReport?.handoff === 'seen', 'the handoff was injected into the first turn', second.final)
check(secondReport !== undefined && secondReport.result.length > 0 && !/error/i.test(secondReport.result.slice(0, 40)), 'the native memory_handoff_list tool returned data', secondReport?.result)
if (handoffId !== undefined) {
  const after = callJson('memory_handoff_list', {}, project)
  check(!(after.value?.handoffs ?? []).some(h => h.id === handoffId), 'the claimed handoff is no longer open (single-use)')
}
let bothEnded = false
for (let attempt = 0; attempt < 30 && !bothEnded; attempt++) {
  const list = projectSessions()
  bothEnded = list.length === 2 && list.every(s => s.ended === true)
  if (!bothEnded) await sleep(1_000)
}
check(bothEnded, 'the second session ended by itself too', JSON.stringify(projectSessions()))

// --- session 3: compaction in a resumed session ---
console.log('\nsession 3 — compaction')
if (second.sessionId === undefined) {
  fail('session 2 reported no id; cannot resume it')
} else {
  const third = runDsh('E2E_COMPACT third run: keep going after a compaction', ['--session-id', second.sessionId])
  check(third.code === 0, 'dsh headless resumed the session and finished', `exit ${third.code}: ${third.stderr.slice(-600)}`)
  const thirdReport = report(third.final)
  check(thirdReport?.anchor === 'seen', 'after the compaction the model saw the ai-memory anchor', third.final)
  check(thirdReport?.handoff === 'absent', 'a resumed session claims no handoff', third.final)
  const compacted = await observationKinds(second.sessionId, ['pre-compact'])
  check(compacted.kinds.includes('pre-compact'), 'ai-memory recorded pre-compact', `kinds: ${compacted.kinds.join(', ')}`)
}

// --- cleanup ---
if (!keep) {
  const listed = aiMemory(['list-projects'], project).stdout.split('\n').find(line => line.includes(`dsh-ai-memory-e2e-${stamp}`))
  const projectName = listed?.trim().split(/\s+/).find(word => word.includes(`dsh-ai-memory-e2e-${stamp}`))
  if (projectName !== undefined) {
    const purge = aiMemory(['purge-project', '--project', projectName.replace(/^.*\//, ''), '--confirm'], project)
    console.log(`\ncleanup: purge-project ${projectName} → exit ${purge.code}`)
  } else {
    console.log('\ncleanup: the e2e project was not listed; nothing to purge')
  }
  rmSync(project, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
  rmSync(patchPath, { force: true })
}

console.log(failures === 0 ? '\nE2E OK' : `\nE2E FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
