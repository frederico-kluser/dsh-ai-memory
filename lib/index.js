/**
 * dsh-ai-memory — native DeepSeek Harness integration for ai-memory.
 *
 * Replaces the Claude Code hooks bridge (`@deepseek-ai/dsh-hooks-claude-code`
 * + a generated `hooks.json`) with a typed plugin on DSH's own extension
 * points. Compared with the bridge it adds what ai-memory's support matrix
 * lists as missing for DSH, and removes the Windows failure modes:
 *
 * | ai-memory needs            | DSH seam used here                         |
 * |----------------------------|--------------------------------------------|
 * | SessionStart (+ handoff)   | `agent/created` — serial, awaited before   |
 * |                            | the first step, so the handoff lands in    |
 * |                            | the first turn                             |
 * | UserPromptSubmit           | `agent/pre-step`, operator messages only   |
 * | PreToolUse / PostToolUse   | `tools/pre-execute` / `tools/result`       |
 * | Stop                       | `session/event` `turn/end` (every ending)  |
 * | PreCompact (+ anchor)      | `session/event` `compaction/start`/`end`   |
 * | SubagentStart / Stop       | `subagent/start` / `subagent/end`          |
 * | SessionEnd (+ auto handoff)| `agent/disposed`, plus plugin disposal     |
 *
 * Every capture runs the native `ai-memory hook` command (capture policy,
 * redaction and the offline spool stay ai-memory's), spawned with an argv
 * array — no shell — on Windows, macOS and Linux.
 * @module dsh-ai-memory
 */
import { randomUUID } from 'node:crypto';
import { discoverBinary, processDiscoveryEnv } from './binary.js';
import { AiMemoryCli, describeFailure } from './cli.js';
import { resolveConfig } from './config.js';
import { loadAnchor, loadStartupContext } from './context.js';
import { instructionsText, SECTION_NAME, SECTION_ORDER } from './instructions.js';
import { normalizeCwd } from './paths.js';
import * as P from './payloads.js';
import { SerialQueues } from './queue.js';
import { listServerTools, META_TOOL, metaTool, nativeTool, selectTools } from './tools.js';
export const name = 'dsh-ai-memory';
/** `tools` registers the model-facing tools; every other service is optional (`ctx.get`). */
export const inject = ['tools'];
/** The message source stamped on every context this plugin injects. */
export const CONTEXT_SOURCE = Object.freeze({ kind: 'dsh-ai-memory' });
/**
 * Where the operator can read the plugin's few diagnostic lines (activation,
 * warnings, a claimed handoff). Cordis keeps `ctx.logger` records in an
 * in-memory buffer with no console exporter in the web profile, so they would
 * never reach `~/.dsh/logs/dsh-web.log`; sibling DSH plugins write their
 * status lines to stderr for the same reason. Lines go to stderr only when it
 * is redirected (a log file or a pipe), so an interactive terminal UI is never
 * drawn over; `DSH_AI_MEMORY_VERBOSE=1` forces them, `DSH_AI_MEMORY_QUIET=1`
 * silences them.
 */
export function defaultDiagnostics(env = process.env, stderr = process.stderr) {
    if (env['DSH_AI_MEMORY_QUIET'] === '1')
        return undefined;
    if (stderr.isTTY === true && env['DSH_AI_MEMORY_VERBOSE'] !== '1')
        return undefined;
    return (line) => {
        try {
            stderr.write(`${line}\n`);
        }
        catch {
            // a closed stderr must never break the harness
        }
    };
}
/** Build one frozen context message in `createUserMessage` shape. */
export function contextMessage(text) {
    return Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text })]),
        source: CONTEXT_SOURCE,
    });
}
/** Resolve within `ms`, or to `fallback` — never rejects. */
async function within(work, ms, fallback) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
    });
    try {
        return await Promise.race([work.catch(() => fallback), timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
export function apply(ctx, rawConfig, overrides = {}) {
    const logger = ctx.logger ?? console;
    const diagnostics = 'diagnostics' in overrides ? overrides.diagnostics : defaultDiagnostics();
    const visible = (message) => diagnostics?.(`[dsh-ai-memory] ${message}`);
    const warn = (message) => {
        logger.warn(`dsh-ai-memory: ${message}`);
        visible(`warning: ${message}`);
    };
    const info = (message) => {
        logger.info(`dsh-ai-memory: ${message}`);
        visible(message);
    };
    const debug = (message) => (logger.debug ?? logger.info).call(logger, `dsh-ai-memory: ${message}`);
    const config = resolveConfig(rawConfig, warn);
    const discovered = overrides.discovery ?? discoverBinary(config.binary, processDiscoveryEnv());
    if ('error' in discovered) {
        warn(`${discovered.error} — the plugin stays inactive. Searched: ${discovered.searched.join(', ')}`);
        return;
    }
    const cli = overrides.cli ?? new AiMemoryCli(discovered.path, { dataDir: config.dataDir });
    info(`active — using ${discovered.path} (found via ${discovered.source}), agent label "${config.agent}"`);
    let disposed = false;
    const sessions = new Map();
    // --- failure reporting: first failure per kind at once, then one line a minute ---
    const failures = new Map();
    const reportFailure = (kind, detail) => {
        const now = Date.now();
        const entry = failures.get(kind) ?? { count: 0, lastAt: 0 };
        entry.count += 1;
        if (entry.count === 1 || now - entry.lastAt > 60_000) {
            warn(`${kind} failed (${entry.count}×): ${detail}`);
            entry.lastAt = now;
        }
        failures.set(kind, entry);
    };
    const queues = new SerialQueues(256, (key) => reportFailure('capture backlog', `session ${key} has 256 pending events; dropping new ones`));
    // --- optional services, read when used so a profile may omit them ---
    const agents = () => ctx.get('agents');
    const workingDirectory = () => ctx.get('workingDirectory');
    const cwdOfSession = (session) => {
        try {
            const dir = workingDirectory()?.get(session);
            if (typeof dir === 'string' && dir !== '')
                return normalizeCwd(dir);
        }
        catch {
            // not resolved yet: fall back to the header
        }
        return normalizeCwd(session.header.cwd ?? process.cwd());
    };
    const hookArgs = (event) => [
        'hook', '--event', event, '--agent', config.agent,
        ...config.serverUrl !== undefined ? ['--server-url', config.serverUrl] : [],
    ];
    const modelOf = (agent) => {
        try {
            return agent.model?.current()?.model;
        }
        catch {
            return undefined;
        }
    };
    // --- capture ---
    const enqueueHook = (state, payload) => {
        if (!config.capture || state.ignored || disposed)
            return;
        const event = P.cliEventName(payload.hook_event_name);
        const stdin = JSON.stringify(payload);
        queues.enqueue(state.id, async () => {
            const result = await cli.run({ args: hookArgs(event), cwd: state.cwd, stdin, timeoutMs: config.hookTimeoutMs });
            if (result.code !== 0)
                reportFailure(`hook ${event}`, describeFailure(result, config.hookTimeoutMs));
        });
    };
    const fields = (state) => P.base(state.id, state.cwd);
    /**
     * The state for a session, created on first sight. A session first seen
     * through a later event (the plugin was hot-loaded or reloaded while the
     * agent lived) starts with a `resume` session-start so ai-memory sees a
     * well-formed lifecycle.
     */
    const stateOf = (agent, startSource) => {
        const id = agent.session.header.id;
        const known = sessions.get(id);
        // A new agent for a session that already ended (closed, then reopened)
        // starts a new lifecycle; any other sighting reuses the live state.
        if (known !== undefined && !(startSource !== undefined && known.endRequested)) {
            known.cwd = cwdOfSession(agent.session);
            return known;
        }
        const state = {
            id,
            cwd: cwdOfSession(agent.session),
            ignored: agent.session.header.origin === 'subagent' && !config.captureSubagentSessions,
            endRequested: false,
            endDelivered: false,
        };
        sessions.set(id, state);
        enqueueHook(state, P.sessionStart(fields(state), startSource ?? 'resume', modelOf(agent)));
        return state;
    };
    const stateById = (id) => {
        const known = sessions.get(id);
        if (known !== undefined)
            return known;
        const agent = agents()?.get(id);
        return agent !== undefined ? stateOf(agent) : undefined;
    };
    const deliverEnd = (state, reason, mode) => {
        state.endRequested = true;
        if (state.endDelivered || state.ignored || !config.capture)
            return;
        const stdin = JSON.stringify(P.sessionEnd(fields(state), reason));
        if (mode === 'detached') {
            state.endDelivered = true;
            if (!cli.launchDetached({ args: hookArgs('session-end'), cwd: state.cwd, stdin }))
                reportFailure('hook session-end', 'could not start ai-memory');
            return;
        }
        queues.enqueue(state.id, async () => {
            if (state.endDelivered)
                return;
            state.endDelivered = true;
            const result = await cli.run({ args: hookArgs('session-end'), cwd: state.cwd, stdin, timeoutMs: config.hookTimeoutMs });
            if (result.code !== 0)
                reportFailure('hook session-end', describeFailure(result, config.hookTimeoutMs));
        });
    };
    const injectContext = (agent, outcome, what) => {
        if (outcome.text !== undefined)
            info(`${what}: ${outcome.note}`);
        else
            debug(`${what}: ${outcome.note}`);
        if (outcome.text === undefined || agent === undefined || disposed)
            return;
        try {
            agent.inject(contextMessage(outcome.text));
        }
        catch (error) {
            reportFailure(`inject ${what}`, String(error));
        }
    };
    // --- tools and the system-prompt section ---
    const toolsService = ctx.get('tools');
    const runtime = {
        cli,
        timeoutMs: config.toolTimeoutMs,
        cwdOf: agent => agent !== undefined ? cwdOfSession(agent.session) : undefined,
    };
    const toolDisposers = [];
    let sectionDisposer;
    let toolsState = config.tools === 'none' ? 'ready' : 'idle';
    let lastToolAttempt = 0;
    const registerSection = (tools, meta) => {
        if (!config.instructions || disposed)
            return;
        const systemPrompt = ctx.get('systemPrompt');
        if (systemPrompt === undefined)
            return;
        try {
            sectionDisposer?.();
            sectionDisposer = systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: instructionsText({ tools, meta }) });
        }
        catch (error) {
            reportFailure('system prompt section', String(error));
        }
    };
    const loadTools = (cwd) => {
        if (toolsState !== 'idle' || toolsService === undefined || disposed)
            return;
        if (Date.now() - lastToolAttempt < 30_000)
            return;
        lastToolAttempt = Date.now();
        toolsState = 'loading';
        void listServerTools(cli, cwd, Math.max(config.startupTimeoutMs, 10_000)).then(({ tools, error }) => {
            if (disposed)
                return;
            if (error !== undefined) {
                toolsState = 'idle';
                reportFailure('tool listing', `${error}; retrying when the next session starts`);
                return;
            }
            const { native, behindMeta } = selectTools(config.tools, tools);
            const definitions = [...native.map(tool => nativeTool(runtime, tool)), ...behindMeta.length > 0 ? [metaTool(runtime, behindMeta)] : []];
            for (const definition of definitions) {
                try {
                    toolDisposers.push(toolsService.register(definition));
                }
                catch (registrationError) {
                    reportFailure(`register ${definition.name}`, String(registrationError));
                }
            }
            toolsState = 'ready';
            registerSection(toolDisposers.length > 0, behindMeta.length > 0 && definitions.some(d => d.name === META_TOOL));
            debug(`registered ${toolDisposers.length} tool(s): ${definitions.map(d => d.name).join(', ')}`);
        });
    };
    registerSection(false, false);
    loadTools(undefined);
    // --- SessionStart: serial and awaited before the first step ---
    ctx.on('agent/created', async ({ agent, source, signal }) => {
        try {
            const state = stateOf(agent, source);
            if (state.ignored)
                return undefined;
            loadTools(state.cwd);
            if (config.handoff && config.handoffSources.includes(source)) {
                const outcome = await within(loadStartupContext(cli, { cwd: state.cwd, sessionId: state.id, timeoutMs: config.startupTimeoutMs, signal }), config.startupTimeoutMs + 500, { note: `startup context timed out after ${config.startupTimeoutMs} ms` });
                injectContext(agent, outcome, 'startup context');
            }
        }
        catch (error) {
            reportFailure('session start', String(error));
        }
        return undefined;
    });
    // --- UserPromptSubmit: only what the operator typed (source kind `user`) ---
    ctx.on('agent/pre-step', async (payload, next) => {
        try {
            const typed = payload.messages.filter(message => message.source?.kind === 'user');
            if (typed.length > 0) {
                const state = stateOf(payload.agent);
                const prompt = typed.map(message => P.blocksToText(message.content)).filter(text => text !== '').join('\n\n');
                if (prompt !== '')
                    enqueueHook(state, P.userPrompt(fields(state), prompt));
            }
        }
        catch (error) {
            reportFailure('prompt capture', String(error));
        }
        return next();
    });
    // --- PreToolUse: observe, then always delegate the decision ---
    ctx.on('tools/pre-execute', async (exec, next) => {
        try {
            if (config.captureTools && exec.agent !== undefined) {
                const state = stateOf(exec.agent);
                enqueueHook(state, P.preToolUse(fields(state), exec.name, exec.arguments, exec.callId));
            }
        }
        catch (error) {
            reportFailure('tool capture', String(error));
        }
        return next();
    });
    // --- PostToolUse: the frozen final outcome ---
    ctx.on('tools/result', (exec, result) => {
        try {
            if (config.captureTools && exec.agent !== undefined) {
                const state = stateOf(exec.agent);
                enqueueHook(state, P.postToolUse(fields(state), exec.name, exec.arguments, exec.callId, P.blocksToText(result.content), result.isError));
            }
        }
        catch (error) {
            reportFailure('tool capture', String(error));
        }
        return undefined;
    });
    // --- Stop, PreCompact and the post-compaction anchor, from the session log ---
    ctx.on('session/event', (session, event) => {
        try {
            const type = event.type;
            if (type !== 'turn/end' && type !== 'compaction/start' && type !== 'compaction/end')
                return;
            const state = stateById(session.header.id);
            if (state === undefined || state.ignored)
                return;
            const data = (typeof event.data === 'object' && event.data !== null ? event.data : {});
            if (type === 'turn/end') {
                const reason = data['reason'];
                enqueueHook(state, P.stop(fields(state), typeof reason?.kind === 'string' ? reason.kind : undefined));
                return;
            }
            if (type === 'compaction/start') {
                const manual = data['sourceCommandId'] !== undefined || data['turn'] === null;
                enqueueHook(state, P.preCompact(fields(state), manual ? 'manual' : 'auto'));
                return;
            }
            // compaction/end: a successful compaction gets the anchor; it queues
            // behind this session's captures so the latest prompt is already sent.
            if (!config.anchor || typeof data['error'] === 'string')
                return;
            queues.enqueue(state.id, async () => {
                const outcome = await loadAnchor(cli, { cwd: state.cwd, sessionId: state.id, timeoutMs: config.startupTimeoutMs });
                injectContext(agents()?.get(state.id), outcome, 'post-compaction anchor');
            });
        }
        catch (error) {
            reportFailure('session event', String(error));
        }
    });
    // --- SubagentStart / SubagentStop, on the child session (as the official bridge) ---
    ctx.on('subagent/start', (info) => {
        try {
            if (!config.captureSubagents)
                return;
            const child = agents()?.get(info.id);
            const cwd = sessions.get(info.id)?.cwd ?? (child !== undefined ? cwdOfSession(child.session) : normalizeCwd(process.cwd()));
            const edge = { id: info.id, cwd, ignored: false, endRequested: true, endDelivered: true };
            enqueueHook(edge, P.subagentStart(fields(edge), info.id));
        }
        catch (error) {
            reportFailure('subagent capture', String(error));
        }
    });
    ctx.on('subagent/end', (info) => {
        try {
            if (!config.captureSubagents)
                return;
            const cwd = sessions.get(info.id)?.cwd ?? normalizeCwd(process.cwd());
            const edge = { id: info.id, cwd, ignored: false, endRequested: true, endDelivered: true };
            enqueueHook(edge, P.subagentStop(fields(edge), info.id, P.blocksToText(info.lastAssistantMessage)));
        }
        catch (error) {
            reportFailure('subagent capture', String(error));
        }
    });
    // --- SessionEnd: the agent left the registry ---
    ctx.on('agent/disposed', ({ agent }) => {
        try {
            const state = sessions.get(agent.session.header.id);
            if (state === undefined)
                return;
            deliverEnd(state, 'other', 'queue');
            void queues.idle(state.id).then(() => {
                // Only forget this lifecycle; a reopened session has a new state.
                if (state.endDelivered && sessions.get(state.id) === state)
                    sessions.delete(state.id);
            });
        }
        catch (error) {
            reportFailure('session end', String(error));
        }
    });
    // --- plugin disposal (DSH shutdown or a reload): close what is still open ---
    ctx.effect(() => () => {
        for (const state of sessions.values())
            deliverEnd(state, 'other', 'detached');
        disposed = true;
        sessions.clear();
        for (const dispose of toolDisposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // already unregistered by the scope
            }
        }
        try {
            sectionDisposer?.();
        }
        catch {
            // already disposed by the scope
        }
    }, 'dsh-ai-memory: end open sessions');
}
