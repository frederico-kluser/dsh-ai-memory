/**
 * Run the ai-memory executable directly — never through a shell.
 *
 * The DSH Claude Code hooks bridge runs each hook command string through the
 * harness shell service, which is PowerShell on Windows. That is where the
 * Windows failures came from: a quoted executable path parsed as a string
 * expression (ai-memory #2134), `--` parsed as an operator, quoting rules that
 * differ between shells. This module spawns the binary with an argv array, so
 * no shell parses anything on any OS. It also hides the console window a
 * GUI-launched DSH would otherwise flash on Windows, bounds every run with a
 * timeout, and never rejects: a failure is a value the caller logs.
 * @module cli
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'

export interface RunOptions {
  /** Arguments after the global ones (the subcommand and its flags). */
  readonly args: readonly string[]
  /** Working directory; ai-memory resolves the project from it. Falls back to home. */
  readonly cwd?: string | undefined
  /** Text written to stdin, then stdin is closed. */
  readonly stdin?: string | undefined
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

export interface RunResult {
  /** Exit code, or null when killed or never started. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  /** Set when the process could not start (ENOENT, EACCES, …). */
  readonly spawnError?: string
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

const MAX_STDOUT = 8 * 1024 * 1024
const MAX_STDERR = 256 * 1024
/** CreateProcess caps the whole command line at 32 767 UTF-16 units. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_000

/** Remove ANSI color sequences. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * The stderr lines worth surfacing: no ANSI, no `INFO`/`DEBUG` tracing lines.
 * @param stderr - raw stderr.
 * @returns at most the last `maxChars` characters of the meaningful lines.
 */
export function meaningfulStderr(stderr: string, maxChars = 600): string {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '' && !/^\S*\s+(INFO|DEBUG|TRACE)\s/.test(line))
  const joined = lines.join('\n')
  return joined.length > maxChars ? `…${joined.slice(-maxChars)}` : joined
}

function existingDirectory(candidate: string | undefined): string {
  if (candidate !== undefined && candidate !== '') {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // fall through to home
    }
  }
  return homedir()
}

export interface CliOptions {
  /** Prepended before the global flags; tests use it to run a Node fake. */
  readonly prefixArgs?: readonly string[]
  /** `--data-dir`, when configured. */
  readonly dataDir?: string | undefined
  /** Extra environment for every child. */
  readonly env?: Readonly<Record<string, string>>
  readonly spawn?: SpawnFunction
  readonly platform?: NodeJS.Platform
}

/** A handle on one ai-memory install. */
export class AiMemoryCli {
  readonly binary: string
  private readonly prefixArgs: readonly string[]
  private readonly globalArgs: readonly string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly spawnFn: SpawnFunction
  private readonly platform: NodeJS.Platform

  constructor(binary: string, options: CliOptions = {}) {
    this.binary = binary
    this.prefixArgs = options.prefixArgs ?? []
    this.globalArgs = options.dataDir !== undefined ? ['--data-dir', options.dataDir] : []
    // NO_COLOR keeps tracing output free of escape codes; everything else is
    // inherited so ai-memory sees the same AI_MEMORY_* settings as the user.
    this.env = { ...process.env, NO_COLOR: '1', ...options.env }
    this.spawnFn = options.spawn ?? (spawn as unknown as SpawnFunction)
    this.platform = options.platform ?? process.platform
  }

  /** The full argv for one invocation. */
  argv(args: readonly string[]): string[] {
    return [...this.prefixArgs, ...this.globalArgs, ...args]
  }

  /**
   * Whether an argv fits the OS command line. Only Windows has a limit small
   * enough to matter (a large page passed to `call`).
   */
  fitsCommandLine(args: readonly string[]): boolean {
    if (this.platform !== 'win32') return true
    const length = [this.binary, ...this.argv(args)].reduce((sum, arg) => sum + arg.length + 3, 0)
    return length <= WINDOWS_COMMAND_LINE_LIMIT
  }

  /**
   * Run once and collect the output. Never rejects.
   * @param options - arguments, cwd, stdin, timeout and cancellation.
   * @returns the outcome.
   */
  run(options: RunOptions): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false
      let settled = false
      let child: ChildProcess
      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(killTimer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const kill = (): void => {
        try {
          child.kill()
        } catch {
          // already gone
        }
        // A process that ignores SIGTERM gets SIGKILL; Windows kill() is already final.
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
        }, 2_000)
        killTimer.unref?.()
      }
      const onAbort = (): void => {
        aborted = true
        kill()
      }

      try {
        child = this.spawnFn(this.binary, this.argv(options.args), {
          cwd: existingDirectory(options.cwd),
          env: this.env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error: unknown) {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: String(error) })
        return
      }

      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, options.timeoutMs)
      timer.unref?.()
      if (options.signal !== undefined) {
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk
      })
      child.on('error', (error: Error) => {
        finish({ code: null, stdout, stderr, timedOut, aborted, spawnError: error.message })
      })
      child.on('close', (code: number | null) => {
        finish({ code, stdout, stderr, timedOut, aborted })
      })

      // EPIPE when the child exits before reading stdin is not an error here.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.stdin ?? '')
    })
  }

  /**
   * Start a process that outlives this one (used for the session-end event
   * while DSH shuts down). Output is discarded; stdin is written and closed.
   * @returns whether the process started.
   */
  launchDetached(options: { readonly args: readonly string[]; readonly cwd?: string | undefined; readonly stdin?: string | undefined }): boolean {
    try {
      const child = this.spawnFn(this.binary, this.argv(options.args), {
        cwd: existingDirectory(options.cwd),
        env: this.env,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.on('error', () => {})
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.stdin ?? '')
      child.unref()
      return true
    } catch {
      return false
    }
  }
}

/** A one-line description of a failed run, for logs and tool errors. */
export function describeFailure(result: RunResult, timeoutMs: number): string {
  if (result.spawnError !== undefined) return `could not start ai-memory: ${result.spawnError}`
  if (result.timedOut) return `ai-memory did not finish within ${timeoutMs} ms`
  if (result.aborted) return 'cancelled'
  const detail = meaningfulStderr(result.stderr)
  return `ai-memory exited with code ${String(result.code)}${detail !== '' ? `: ${detail}` : ''}`
}
