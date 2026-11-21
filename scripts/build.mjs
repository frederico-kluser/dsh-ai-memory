#!/usr/bin/env node
/**
 * Build `lib/` from `src/` with the TypeScript compiler (no bundler: the
 * plugin has no runtime dependencies, so tsc's ESM output is the artifact).
 *
 *   node scripts/build.mjs           rebuild lib/
 *   node scripts/build.mjs --check   fail when the committed lib/ is stale
 *
 * `lib/` is committed so `dsh plugin add github:…` installs without running a
 * build script on the user's machine.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const check = process.argv.includes('--check')

function compile(outDir) {
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json'), '--outDir', outDir], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function files(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(dir, path).split('\\').join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

if (!check) {
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  compile(join(root, 'lib'))
  console.log(`built ${files(join(root, 'lib')).length} files into lib/`)
  process.exit(0)
}

const fresh = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-lib-'))
try {
  compile(fresh)
  const want = files(fresh)
  const have = files(join(root, 'lib'))
  const problems = []
  for (const file of new Set([...want, ...have])) {
    if (!want.includes(file)) problems.push(`lib/${file} is not produced by the sources`)
    else if (!have.includes(file)) problems.push(`lib/${file} is missing`)
    else if (readFileSync(join(fresh, file), 'utf8').replace(/\r\n/g, '\n') !== readFileSync(join(root, 'lib', file), 'utf8').replace(/\r\n/g, '\n')) problems.push(`lib/${file} differs from the sources`)
  }
  if (problems.length > 0) {
    console.error(`Erro: lib/ está desatualizado — Solução: corra \`npm run build\` e commite lib/\n${problems.map(p => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`lib/ matches the sources (${want.length} files)`)
} finally {
  rmSync(fresh, { recursive: true, force: true })
}
