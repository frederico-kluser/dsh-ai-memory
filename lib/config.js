/**
 * Plugin configuration: every field is optional and every default works on a
 * standard ai-memory install. Values arrive from the profile patch row
 * (`- id: dsh-ai-memory` / `config:`); invalid values fall back to the default
 * with a warning instead of failing the harness boot.
 * @module config
 */
import { cleanPath } from './paths.js';
export const DEFAULTS = Object.freeze({
    binary: undefined,
    dataDir: undefined,
    serverUrl: undefined,
    agent: 'dsh',
    capture: true,
    captureTools: true,
    captureSubagents: true,
    captureSubagentSessions: false,
    handoff: true,
    handoffSources: Object.freeze(['startup', 'clear']),
    anchor: true,
    tools: 'core',
    instructions: true,
    hookTimeoutMs: 15_000,
    startupTimeoutMs: 6_000,
    toolTimeoutMs: 60_000,
});
/** ai-memory's agent labels are lowercase words; anything else is refused. */
const AGENT_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * Apply defaults and validate. Never throws: a bad field is reported through
 * `warn` and replaced by its default, so a typo cannot stop the harness.
 * @param raw - the config object from the patch row (may be undefined).
 * @param warn - receives one message per rejected field.
 * @returns the resolved config.
 */
export function resolveConfig(raw, warn = () => { }) {
    const input = (typeof raw === 'object' && raw !== null ? raw : {});
    const out = { ...DEFAULTS };
    const text = (key) => {
        const value = input[key];
        if (value === undefined || value === null)
            return undefined;
        if (typeof value !== 'string') {
            warn(`config.${key} must be a string; ignored`);
            return undefined;
        }
        return value;
    };
    const flag = (key) => {
        const value = input[key];
        if (value === undefined || value === null)
            return;
        if (typeof value !== 'boolean') {
            warn(`config.${key} must be true or false; using ${String(DEFAULTS[key])}`);
            return;
        }
        ;
        out[key] = value;
    };
    const millis = (key, min, max) => {
        const value = input[key];
        if (value === undefined || value === null)
            return;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            warn(`config.${key} must be an integer between ${min} and ${max}; using ${DEFAULTS[key]}`);
            return;
        }
        out[key] = value;
    };
    const binary = text('binary');
    if (binary !== undefined && cleanPath(binary) !== '')
        out.binary = cleanPath(binary);
    const dataDir = text('dataDir');
    if (dataDir !== undefined && cleanPath(dataDir) !== '')
        out.dataDir = cleanPath(dataDir);
    const serverUrl = text('serverUrl');
    if (serverUrl !== undefined && serverUrl.trim() !== '') {
        if (/^https?:\/\/\S+$/i.test(serverUrl.trim()))
            out.serverUrl = serverUrl.trim().replace(/\/+$/, '');
        else
            warn('config.serverUrl must be an http(s) URL; ignored');
    }
    const agent = text('agent');
    if (agent !== undefined) {
        if (AGENT_LABEL.test(agent))
            out.agent = agent;
        else
            warn(`config.agent "${agent}" is not a valid agent label; using "${DEFAULTS.agent}"`);
    }
    flag('capture');
    flag('captureTools');
    flag('captureSubagents');
    flag('captureSubagentSessions');
    flag('handoff');
    flag('anchor');
    flag('instructions');
    const sources = input['handoffSources'];
    if (sources !== undefined && sources !== null) {
        if (Array.isArray(sources) && sources.every(s => typeof s === 'string'))
            out.handoffSources = Object.freeze([...sources]);
        else
            warn('config.handoffSources must be a list of strings; using ["startup", "clear"]');
    }
    const tools = input['tools'];
    if (tools !== undefined && tools !== null) {
        if (tools === 'core' || tools === 'all' || tools === 'none')
            out.tools = tools;
        else if (Array.isArray(tools) && tools.every(t => typeof t === 'string' && TOOL_NAME.test(t)))
            out.tools = Object.freeze([...tools]);
        else
            warn('config.tools must be "core", "all", "none" or a list of tool names; using "core"');
    }
    millis('hookTimeoutMs', 1_000, 300_000);
    millis('startupTimeoutMs', 500, 60_000);
    millis('toolTimeoutMs', 1_000, 600_000);
    return Object.freeze(out);
}
