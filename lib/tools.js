/**
 * The ai-memory tools, registered as native DSH tools.
 *
 * Each call runs `ai-memory call <tool> '<json>'` in the session's own working
 * directory, so ai-memory scopes it to that session's project, resolves the
 * server and bearer token itself, and nothing long-lived (no MCP bridge
 * process, no `\\?\` data-dir argument) is involved.
 *
 * All 27 ai-memory tools cost ~20k tokens of schema. The default `core` mode
 * registers the seven a coding session needs and folds the rest into one
 * `memory_call` tool that can describe and call any of them.
 * @module tools
 */
import { describeFailure, meaningfulStderr, stripAnsi } from './cli.js';
/** Registered natively in `core` mode. */
export const CORE_TOOLS = Object.freeze([
    'memory_query',
    'memory_read_page',
    'memory_handoff_begin',
    'memory_handoff_accept',
    'memory_handoff_list',
    'memory_read_session_observations',
    'memory_write_page',
]);
export const META_TOOL = 'memory_call';
const MAX_DESCRIPTION = 1_600;
const OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
});
/** Parse the `ai-memory call` listing (a JSON array of MCP tools). */
export function parseToolList(stdout) {
    let value;
    try {
        value = JSON.parse(stdout.trim());
    }
    catch {
        return [];
    }
    if (!Array.isArray(value))
        return [];
    const tools = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        const name = record['name'];
        if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name))
            continue;
        const schema = record['inputSchema'];
        tools.push({
            name,
            description: typeof record['description'] === 'string' ? record['description'] : '',
            inputSchema: typeof schema === 'object' && schema !== null && !Array.isArray(schema)
                ? schema
                : { type: 'object', properties: {} },
        });
    }
    return tools;
}
/** Cut a description at a sentence boundary near `max`. */
export function trimDescription(text, max = MAX_DESCRIPTION) {
    if (text.length <= max)
        return text;
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
    return `${end > max / 2 ? cut.slice(0, end + 1) : cut}…`;
}
/** The first sentence of a description, for the `memory_call` catalog. */
export function firstSentence(text, max = 140) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const end = flat.search(/[.!?](\s|$)/);
    const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
    return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
}
/** Which of the listed tools become native tools, and which go behind `memory_call`. */
export function selectTools(mode, listed) {
    if (mode === 'none')
        return { native: [], behindMeta: [] };
    if (mode === 'all')
        return { native: [...listed], behindMeta: [] };
    const wanted = new Set(mode === 'core' ? CORE_TOOLS : mode);
    return {
        native: listed.filter(tool => wanted.has(tool.name)),
        behindMeta: listed.filter(tool => !wanted.has(tool.name)),
    };
}
function asArgs(args) {
    return typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
}
/** Run one ai-memory tool and return its text, or throw the tool's error. */
export async function callServerTool(runtime, name, args, exec) {
    const argv = ['call', name, JSON.stringify(args)];
    if (!runtime.cli.fitsCommandLine(argv)) {
        throw new Error(`the arguments for ${name} are too large for the Windows command line (32 767 characters); split the content (for example with memory_patch_page or memory_write_pages_batch)`);
    }
    const result = await runtime.cli.run({ args: argv, cwd: runtime.cwdOf(exec.agent), timeoutMs: runtime.timeoutMs, signal: exec.signal });
    if (result.code === 0)
        return stripAnsi(result.stdout).trim();
    if (result.code === 1 && result.spawnError === undefined && !result.timedOut) {
        const message = meaningfulStderr(result.stderr, 4_000);
        throw new Error(message !== '' ? message : `${name} reported an error`);
    }
    throw new Error(`${name}: ${describeFailure(result, runtime.timeoutMs)}`);
}
const output = Object.freeze({
    schema: OUTPUT_SCHEMA,
    render(_args, value) {
        const text = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value['text'] === 'string' ? value['text'] : '';
        return [{ type: 'text', text: text === '' ? '(empty result)' : text }];
    },
});
/** A native DSH tool that proxies one ai-memory tool. */
export function nativeTool(runtime, tool) {
    return {
        name: tool.name,
        description: trimDescription(tool.description),
        parameters: tool.inputSchema,
        output,
        async execute(args, exec) {
            return { text: await callServerTool(runtime, tool.name, asArgs(args), exec) };
        },
    };
}
/** The `memory_call` tool: describe or call any tool not registered natively. */
export function metaTool(runtime, tools) {
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    const catalog = tools.map(tool => `- ${tool.name}: ${firstSentence(tool.description)}`).join('\n');
    return {
        name: META_TOOL,
        description: [
            'Call one of the other ai-memory tools by name.',
            'First pass `describe: true` to get that tool\'s full description and JSON input schema, then call it with `arguments`.',
            'Available tools:',
            catalog,
        ].join('\n'),
        parameters: {
            type: 'object',
            properties: {
                tool: { type: 'string', enum: tools.map(tool => tool.name), description: 'The ai-memory tool to call.' },
                arguments: { type: 'object', description: 'The tool\'s arguments, matching its input schema.', additionalProperties: true },
                describe: { type: 'boolean', description: 'Return the tool\'s description and input schema instead of calling it.' },
            },
            required: ['tool'],
            additionalProperties: false,
        },
        output,
        async execute(args, exec) {
            const input = asArgs(args);
            const name = input['tool'];
            const tool = typeof name === 'string' ? byName.get(name) : undefined;
            if (tool === undefined)
                throw new Error(`unknown ai-memory tool ${JSON.stringify(name)}; choose one of: ${[...byName.keys()].join(', ')}`);
            if (input['describe'] === true) {
                return { text: `${tool.name}\n\n${tool.description}\n\nInput schema:\n${JSON.stringify(tool.inputSchema, null, 2)}` };
            }
            return { text: await callServerTool(runtime, tool.name, asArgs(input['arguments']), exec) };
        },
    };
}
/** List the server's tools. */
export async function listServerTools(cli, cwd, timeoutMs) {
    const result = await cli.run({ args: ['call'], cwd, timeoutMs });
    if (result.code !== 0)
        return { tools: [], error: describeFailure(result, timeoutMs) };
    const tools = parseToolList(result.stdout);
    return tools.length > 0 ? { tools } : { tools, error: 'the tool listing was empty or not JSON' };
}
