/**
 * Per-session serial queues.
 *
 * Capture must reach ai-memory in event order (session-start before the first
 * prompt, a tool's pre before its post) without ever blocking the agent loop.
 * Each session gets one promise chain: listeners enqueue and return at once,
 * and the chain runs one hook process at a time. A stuck hook is bounded by
 * its own timeout, and a runaway backlog is cut at `maxPending` per session.
 * @module queue
 */

export class SerialQueues {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, number>()

  constructor(
    private readonly maxPending: number = 256,
    private readonly onDrop: (key: string) => void = () => {},
  ) {}

  /**
   * Append a task to `key`'s chain.
   * @param key - the session id.
   * @param task - the work; a rejection is swallowed so the chain continues.
   * @returns false when the backlog is full and the task was dropped.
   */
  enqueue(key: string, task: () => Promise<unknown>): boolean {
    const count = this.pending.get(key) ?? 0
    if (count >= this.maxPending) {
      this.onDrop(key)
      return false
    }
    this.pending.set(key, count + 1)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next: Promise<void> = previous
      .then(() => task())
      .then(() => undefined, () => undefined)
      .finally(() => {
        const left = (this.pending.get(key) ?? 1) - 1
        if (left > 0) {
          this.pending.set(key, left)
          return
        }
        this.pending.delete(key)
        if (this.tails.get(key) === next) this.tails.delete(key)
      })
    this.tails.set(key, next)
    return true
  }

  /** Tasks not yet finished for `key`. */
  size(key: string): number {
    return this.pending.get(key) ?? 0
  }

  /** Resolve when every chain (or only `key`'s) has drained. */
  async idle(key?: string): Promise<void> {
    if (key !== undefined) {
      await this.tails.get(key)
      return
    }
    while (this.tails.size > 0) await Promise.all([...this.tails.values()])
  }
}
