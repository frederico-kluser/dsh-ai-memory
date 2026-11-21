import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanPath, expandHome, normalizeCwd, stripVerbatimPrefix } from '../src/paths.js'
import { DEFAULTS, resolveConfig } from '../src/config.js'

test('verbatim prefixes are removed (ai-memory #2032, #2203)', () => {
  assert.equal(stripVerbatimPrefix('\\\\?\\C:\\Users\\me\\AppData\\Local\\ai-memory'), 'C:\\Users\\me\\AppData\\Local\\ai-memory')
  assert.equal(stripVerbatimPrefix('//?/C:/Users/me'), 'C:/Users/me')
  assert.equal(stripVerbatimPrefix('\\\\?\\UNC\\server\\share\\dir'), '\\\\server\\share\\dir')
  assert.equal(stripVerbatimPrefix('C:\\plain'), 'C:\\plain')
  assert.equal(stripVerbatimPrefix('/usr/local/bin'), '/usr/local/bin')
  assert.equal(stripVerbatimPrefix('\\\\server\\share'), '\\\\server\\share')
})

test('home expansion, quotes and blanks', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  assert.equal(expandHome('~/bin/x', '/home/u'), '/home/u/bin/x')
  assert.equal(expandHome('~\\bin', 'C:\\Users\\u'), 'C:\\Users\\u\\bin')
  assert.equal(expandHome('a~b', '/home/u'), 'a~b')
  assert.equal(cleanPath('  "C:\\Program Files\\ai-memory"  '), 'C:\\Program Files\\ai-memory')
  assert.equal(cleanPath('"\\\\?\\C:\\x"'), 'C:\\x')
  assert.equal(cleanPath('   '), '')
})

test('Windows session directories are spelled one way', () => {
  assert.equal(normalizeCwd('c:/Users/me/repo/', 'win32'), 'C:\\Users\\me\\repo')
  assert.equal(normalizeCwd('\\\\?\\C:\\Users\\me\\repo', 'win32'), 'C:\\Users\\me\\repo')
  assert.equal(normalizeCwd('C:\\', 'win32'), 'C:\\')
  assert.equal(normalizeCwd('/Volumes/Ext2TB/Projects/x/', 'darwin'), '/Volumes/Ext2TB/Projects/x')
  assert.equal(normalizeCwd('/', 'linux'), '/')
})

test('defaults need no configuration', () => {
  const config = resolveConfig(undefined)
  assert.deepEqual(config, DEFAULTS)
  assert.equal(config.agent, 'dsh')
  assert.deepEqual(config.handoffSources, ['startup', 'clear'])
  assert.equal(config.tools, 'core')
})

test('valid values are applied and paths are cleaned', () => {
  const config = resolveConfig({
    binary: '"\\\\?\\C:\\Tools\\ai-memory.exe"',
    dataDir: '~/state',
    serverUrl: 'http://127.0.0.1:49374/',
    agent: 'dsh',
    tools: ['memory_query'],
    handoffSources: ['startup'],
    hookTimeoutMs: 5_000,
    captureTools: false,
  })
  assert.equal(config.binary, 'C:\\Tools\\ai-memory.exe')
  assert.ok(config.dataDir?.endsWith('state'))
  assert.ok(!config.dataDir?.startsWith('~'))
  assert.equal(config.serverUrl, 'http://127.0.0.1:49374')
  assert.deepEqual(config.tools, ['memory_query'])
  assert.deepEqual(config.handoffSources, ['startup'])
  assert.equal(config.hookTimeoutMs, 5_000)
  assert.equal(config.captureTools, false)
})

test('invalid values fall back to defaults with one warning each, never throw', () => {
  const warnings: string[] = []
  const config = resolveConfig({
    binary: 42,
    serverUrl: 'ftp://nope',
    agent: 'Bad Label!',
    capture: 'yes',
    tools: 'some',
    handoffSources: 'startup',
    hookTimeoutMs: 5,
    startupTimeoutMs: 1.5,
  }, message => warnings.push(message))
  assert.equal(config.binary, undefined)
  assert.equal(config.serverUrl, undefined)
  assert.equal(config.agent, 'dsh')
  assert.equal(config.capture, true)
  assert.equal(config.tools, 'core')
  assert.deepEqual(config.handoffSources, ['startup', 'clear'])
  assert.equal(config.hookTimeoutMs, DEFAULTS.hookTimeoutMs)
  assert.equal(config.startupTimeoutMs, DEFAULTS.startupTimeoutMs)
  assert.equal(warnings.length, 8)
})
