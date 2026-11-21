#!/usr/bin/env node
/**
 * Compile src/ + test/ into dist/ and run every `*.test.js` with node:test.
 * Portable on purpose: npm runs scripts through cmd.exe on Windows, which
 * expands no globs, so the file list is built here.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
rmSync(join(root, 'dist'), { recursive: true, force: true })
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const compiled = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.test.json')], { cwd: root, stdio: 'inherit' })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)

const testDir = join(root, 'dist', 'test')
const files = readdirSync(testDir).filter(name => name.endsWith('.test.js')).sort().map(name => join(testDir, name))
if (files.length === 0) {
  console.error('Erro: nenhum teste compilado em dist/test — Solução: verifique tsconfig.test.json')
  process.exit(1)
}
// One file at a time: the suites spawn real processes and time them.
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit' })
process.exit(run.status ?? 1)
