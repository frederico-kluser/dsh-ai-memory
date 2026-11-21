import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AiMemoryCli, describeFailure, meaningfulStderr, stripAnsi, type SpawnFunction } from '../src/cli.js'
import { FakeAiMemory, tempDir, waitFor } from './helpers.js'

test('arguments reach ai-memory byte-for-byte: no shell parses them (ai-memory #2134)', async () => {
  const fake = new FakeAiMemory({ call: { echoArgv: true } })
  try {
    const hostile = [
      'call', 'memory_query',
      '{"query":"C:\\\\Users\\\\me\\\\repo","note":"quote \\" inside"}',
      'two words', '--data-dir', '$(touch pwned)', '`whoami`', '%PATH%', '& calc', '| more', '; rm -rf /',
      "it's", 'ação 📥', 'trailing\\', '',
    ]
    const result = await fake.cli.run({ args: hostile, timeoutMs: 20_000 })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), hostile)
    assert.equal(existsSync(join(homedir(), 'pwned')), false)
  } finally {
    fake.cleanup()
  }
})

test('stdin carries the payload; the global --data-dir comes first; cwd is honored', async () => {
  const work = tempDir()
  const fake = new FakeAiMemory({}, { dataDir: 'C:\\State\\ai-memory' })
  try {
    const payload = JSON.stringify({ prompt: 'olá — "quoted" \\ back' })
    const result = await fake.cli.run({ args: ['hook', '--event', 'user-prompt-submit', '--agent', 'dsh'], cwd: work.path, stdin: payload, timeoutMs: 20_000 })
    assert.equal(result.code, 0)
    const [call] = fake.calls()
    assert.ok(call !== undefined)
    assert.deepEqual(call.argv, ['--data-dir', 'C:\\State\\ai-memory', 'hook', '--event', 'user-prompt-submit', '--agent', 'dsh'])
    assert.equal(call.stdin, payload)
    // macOS tmpdir is a symlink (/var → /private/var): compare real paths.
    assert.equal(realpathSync(call.cwd).toLowerCase(), realpathSync(work.path).toLowerCase())
  } finally {
    fake.cleanup()
    work.cleanup()
  }
})

test('a vanished cwd falls back to the home directory instead of failing the spawn', async () => {
  const fake = new FakeAiMemory()
  try {
    const result = await fake.cli.run({ args: ['hook'], cwd: join(homedir(), 'does-not-exist-dsh-ai-memory'), timeoutMs: 20_000 })
    assert.equal(result.code, 0)
    assert.equal(realpathSync(fake.calls()[0]?.cwd ?? '').toLowerCase(), realpathSync(homedir()).toLowerCase())
  } finally {
    fake.cleanup()
  }
})

test('exit codes and stderr come back; a hung process is killed at the timeout', async () => {
  const fake = new FakeAiMemory({
    'call memory_lint': { code: 1, stderr: '\u001b[2m2026-11-21T00:00:00Z\u001b[0m \u001b[32m INFO\u001b[0m ai-memory starting\nlint failed: no project\n' },
    'call memory_slow': { sleepMs: 30_000 },
  })
  try {
    const failed = await fake.cli.run({ args: ['call', 'memory_lint'], timeoutMs: 20_000 })
    assert.equal(failed.code, 1)
    assert.equal(meaningfulStderr(failed.stderr), 'lint failed: no project')
    const started = Date.now()
    const slow = await fake.cli.run({ args: ['call', 'memory_slow'], timeoutMs: 600 })
    assert.equal(slow.timedOut, true)
    assert.ok(Date.now() - started < 10_000)
    assert.match(describeFailure(slow, 600), /did not finish within 600 ms/)
  } finally {
    fake.cleanup()
  }
})

test('cancellation kills the run', async () => {
  const fake = new FakeAiMemory({ 'call memory_slow': { sleepMs: 30_000 } })
  try {
    const controller = new AbortController()
    const pending = fake.cli.run({ args: ['call', 'memory_slow'], timeoutMs: 20_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    assert.equal(result.aborted, true)
    assert.equal(describeFailure(result, 20_000), 'cancelled')
  } finally {
    fake.cleanup()
  }
})

test('a missing executable is a value, not an exception', async () => {
  const cli = new AiMemoryCli(join(homedir(), 'no-such-dir', process.platform === 'win32' ? 'ai-memory.exe' : 'ai-memory'))
  const result = await cli.run({ args: ['status'], timeoutMs: 5_000 })
  assert.equal(result.code, null)
  assert.ok(result.spawnError !== undefined)
  assert.match(describeFailure(result, 5_000), /could not start ai-memory/)
})

test('every spawn is shell-free and hides the Windows console', async () => {
  const seen: Array<Record<string, unknown>> = []
  const spy: SpawnFunction = (_command, _args, options) => {
    seen.push(options as Record<string, unknown>)
    throw new Error('spy only')
  }
  const cli = new AiMemoryCli('ai-memory', { spawn: spy })
  await cli.run({ args: ['status'], timeoutMs: 1_000 })
  cli.launchDetached({ args: ['hook'] })
  assert.equal(seen.length, 2)
  for (const options of seen) {
    assert.equal(options['shell'], false)
    assert.equal(options['windowsHide'], true)
  }
  assert.equal(seen[1]?.['detached'], true)
})

test('a detached launch delivers stdin and outlives the call', async () => {
  const fake = new FakeAiMemory()
  try {
    assert.equal(fake.cli.launchDetached({ args: ['hook', '--event', 'session-end'], stdin: '{"reason":"other"}' }), true)
    await waitFor(() => fake.calls().length === 1, 10_000, 'the detached hook')
    assert.equal(fake.calls()[0]?.stdin, '{"reason":"other"}')
  } finally {
    fake.cleanup()
  }
})

test('the Windows command-line limit is enforced only on Windows', () => {
  const windows = new AiMemoryCli('C:\\ai-memory.exe', { platform: 'win32' })
  const posix = new AiMemoryCli('/usr/bin/ai-memory', { platform: 'linux' })
  const huge = ['call', 'memory_write_page', 'x'.repeat(40_000)]
  assert.equal(windows.fitsCommandLine(huge), false)
  assert.equal(windows.fitsCommandLine(['call', 'memory_query', '{}']), true)
  assert.equal(posix.fitsCommandLine(huge), true)
})

test('ANSI sequences are stripped', () => {
  assert.equal(stripAnsi('\u001b[32mgreen\u001b[0m'), 'green')
})
