import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLocations, discoverBinary, executableName, type DiscoveryEnv } from '../src/binary.js'

function env(platform: NodeJS.Platform, vars: Record<string, string>, files: string[], home: string): DiscoveryEnv {
  const set = new Set(files)
  return { platform, env: vars, home, isFile: candidate => set.has(candidate) }
}

test('executable names per OS', () => {
  assert.equal(executableName('win32'), 'ai-memory.exe')
  assert.equal(executableName('darwin'), 'ai-memory')
  assert.equal(executableName('linux'), 'ai-memory')
})

test('Windows: the official installer location is found without PATH', () => {
  const de = env('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, ['C:\\Users\\me\\AppData\\Local\\Programs\\ai-memory\\ai-memory.exe'], 'C:\\Users\\me')
  const found = discoverBinary(undefined, de)
  assert.deepEqual(found, { path: 'C:\\Users\\me\\AppData\\Local\\Programs\\ai-memory\\ai-memory.exe', source: 'default' })
})

test('Windows: PATH is case-insensitive, quoted entries work, verbatim LOCALAPPDATA is cleaned', () => {
  const de = env('win32', { Path: 'C:\\Windows;"C:\\Tools\\ai memory"' }, ['C:\\Tools\\ai memory\\ai-memory.exe'], 'C:\\Users\\me')
  assert.deepEqual(discoverBinary(undefined, de), { path: 'C:\\Tools\\ai memory\\ai-memory.exe', source: 'PATH' })
  const verbatim = env('win32', { LOCALAPPDATA: '\\\\?\\C:\\Users\\me\\AppData\\Local' }, [], 'C:\\Users\\me')
  assert.equal(defaultLocations(verbatim)[0], 'C:\\Users\\me\\AppData\\Local\\Programs\\ai-memory\\ai-memory.exe')
})

test('macOS: a launchd-style PATH still finds ~/.local/bin (install.sh) and Homebrew', () => {
  const local = env('darwin', { PATH: '/usr/bin:/bin' }, ['/Users/me/.local/bin/ai-memory'], '/Users/me')
  assert.deepEqual(discoverBinary(undefined, local), { path: '/Users/me/.local/bin/ai-memory', source: 'default' })
  const brew = env('darwin', { PATH: '/usr/bin' }, ['/opt/homebrew/bin/ai-memory'], '/Users/me')
  assert.deepEqual(discoverBinary(undefined, brew), { path: '/opt/homebrew/bin/ai-memory', source: 'default' })
})

test('Linux: PATH wins over defaults; relative PATH entries are ignored', () => {
  const de = env('linux', { PATH: 'bin:/opt/am/bin:/usr/bin' }, ['/opt/am/bin/ai-memory', '/home/me/.local/bin/ai-memory', 'bin/ai-memory'], '/home/me')
  assert.deepEqual(discoverBinary(undefined, de), { path: '/opt/am/bin/ai-memory', source: 'PATH' })
})

test('AI_MEMORY_BIN beats PATH; config beats everything; a missing configured path is an error', () => {
  const files = ['/custom/ai-memory', '/usr/bin/ai-memory', '/pinned/ai-memory']
  const de = env('linux', { PATH: '/usr/bin', AI_MEMORY_BIN: '/custom/ai-memory' }, files, '/home/me')
  assert.equal((discoverBinary(undefined, de) as { source: string }).source, 'AI_MEMORY_BIN')
  assert.deepEqual(discoverBinary('/pinned/ai-memory', de), { path: '/pinned/ai-memory', source: 'config' })
  const missing = discoverBinary('/nope/ai-memory', de)
  assert.ok('error' in missing)
})

test('nothing found reports every searched location', () => {
  const result = discoverBinary(undefined, env('darwin', { PATH: '/usr/bin' }, [], '/Users/me'))
  assert.ok('error' in result)
  if ('error' in result) {
    assert.ok(result.searched.includes('/usr/bin/ai-memory'))
    assert.ok(result.searched.includes('/Users/me/.local/bin/ai-memory'))
  }
})
