/**
 * Structural views of the DeepSeek Harness (DSH) surfaces this plugin uses.
 *
 * The plugin ships with zero runtime dependencies: it imports nothing from
 * `@deepseek-ai/*` at runtime, so it loads from any filesystem location (a
 * profile bundle, a git checkout, an absolute path in a patch row). These
 * interfaces name only the members the plugin reads or calls, checked against
 * the DSH 0.2.1 sources:
 *
 * - `agent/created` (serial, awaited before creation resolves) and
 *   `agent/disposed` (emit) — `packages/core/agent/src/runtime-types.ts`
 * - `agent/pre-step` (waterfall) — same file
 * - `tools/pre-execute` (waterfall) and `tools/result` (emit, frozen final
 *   outcome) — `packages/core/tools/src/events.ts`
 * - `session/event` with `turn/end`, `assistant/message`, `compaction/start`
 *   and `compaction/end` — `packages/core/session/src/types.ts`,
 *   `packages/compaction/compaction/src/types.ts`
 * - `subagent/start` / `subagent/end` — `packages/subagent/subagent`
 * - `ctx.tools.register()`, `ctx.systemPrompt.section()`,
 *   `ctx.workingDirectory.get()` and `ctx.agents.get()`
 * @module types
 */
export {};
