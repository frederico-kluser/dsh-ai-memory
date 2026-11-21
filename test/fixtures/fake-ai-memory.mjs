#!/usr/bin/env node
/**
 * A stand-in for the ai-memory executable, run as `node fake-ai-memory.mjs …`.
 *
 * Every invocation appends one JSON line to $FAKE_AI_MEMORY_LOG with its argv,
 * cwd and stdin. Replies come from $FAKE_AI_MEMORY_REPLIES, a JSON object
 * keyed by the first one or two positional words (`call memory_handoff_accept`,
 * `call`, `hook`): `{ "stdout": "...", "stderr": "...", "code": 0, "sleepMs": 0 }`.
 * The global `--data-dir <dir>` pair is skipped when picking the key.
 */
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8')
  const logPath = process.env.FAKE_AI_MEMORY_LOG
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv, cwd: process.cwd(), stdin, pid: process.pid })}\n`)

  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') { i++; continue }
    if (argv[i].startsWith('--')) break
    positional.push(argv[i])
  }
  let replies = {}
  if (process.env.FAKE_AI_MEMORY_REPLIES) replies = JSON.parse(readFileSync(process.env.FAKE_AI_MEMORY_REPLIES, 'utf8'))
  const reply = replies[positional.slice(0, 2).join(' ')] ?? replies[positional[0] ?? ''] ?? { stdout: '', code: 0 }
  const finish = () => {
    if (reply.echoArgv) process.stdout.write(JSON.stringify(argv))
    if (reply.stdout) process.stdout.write(reply.stdout)
    if (reply.stderr) process.stderr.write(reply.stderr)
    process.exit(reply.code ?? 0)
  }
  if (reply.sleepMs) setTimeout(finish, reply.sleepMs)
  else finish()
})
