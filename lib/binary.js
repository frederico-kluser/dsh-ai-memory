/**
 * Find the ai-memory executable on every OS without a shell.
 *
 * DSH is often started without a login shell (a desktop launcher, a macOS
 * launchd job, a Windows shortcut), so `PATH` may not hold the user's
 * `~/.local/bin`. Discovery therefore checks, in order: the configured path,
 * `AI_MEMORY_BIN`, every `PATH` entry, then each installer's default location.
 * @module binary
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { cleanPath } from './paths.js';
/** The real environment of this process. */
export function processDiscoveryEnv() {
    return {
        platform: process.platform,
        env: process.env,
        home: homedir(),
        isFile(candidate) {
            try {
                return statSync(candidate).isFile();
            }
            catch {
                return false;
            }
        },
    };
}
/** The executable file name on this platform. */
export function executableName(platform) {
    return platform === 'win32' ? 'ai-memory.exe' : 'ai-memory';
}
/** Read an environment variable; Windows names are case-insensitive. */
function envValue(env, platform, name) {
    const direct = env[name];
    if (direct !== undefined || platform !== 'win32')
        return direct;
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
        if (key.toLowerCase() === wanted)
            return value;
    }
    return undefined;
}
/**
 * The per-OS install locations, most specific first: the official installer
 * (`install.sh` → `~/.local/bin`, Windows → `%LOCALAPPDATA%\Programs\ai-memory`),
 * Homebrew, cargo, then system dirs.
 * @param de - the discovery environment.
 * @returns absolute candidate paths.
 */
export function defaultLocations(de) {
    const p = de.platform === 'win32' ? path.win32 : path.posix;
    const exe = executableName(de.platform);
    const home = de.home;
    if (de.platform === 'win32') {
        const localAppData = cleanPath(envValue(de.env, de.platform, 'LOCALAPPDATA') ?? p.join(home, 'AppData', 'Local'), home);
        const programFiles = cleanPath(envValue(de.env, de.platform, 'ProgramFiles') ?? 'C:\\Program Files', home);
        return [
            p.join(localAppData, 'Programs', 'ai-memory', exe),
            p.join(localAppData, 'ai-memory', 'bin', exe),
            p.join(home, '.local', 'bin', exe),
            p.join(home, '.cargo', 'bin', exe),
            p.join(programFiles, 'ai-memory', exe),
        ];
    }
    const common = [
        p.join(home, '.local', 'bin', exe),
        p.join(home, '.cargo', 'bin', exe),
        p.join('/usr/local/bin', exe),
    ];
    if (de.platform === 'darwin')
        return [...common, p.join('/opt/homebrew/bin', exe)];
    return [...common, p.join('/home/linuxbrew/.linuxbrew/bin', exe), p.join('/usr/bin', exe)];
}
/**
 * Locate the executable.
 * @param configured - the `binary` config value, already cleaned (may be undefined).
 * @param de - the discovery environment.
 * @returns the path and its source, or an error naming every place searched.
 */
export function discoverBinary(configured, de) {
    const searched = [];
    if (configured !== undefined) {
        searched.push(configured);
        if (de.isFile(configured))
            return { path: configured, source: 'config' };
        return { error: `configured binary "${configured}" does not exist or is not a file`, searched };
    }
    const fromEnv = envValue(de.env, de.platform, 'AI_MEMORY_BIN');
    if (fromEnv !== undefined && cleanPath(fromEnv, de.home) !== '') {
        const candidate = cleanPath(fromEnv, de.home);
        searched.push(candidate);
        if (de.isFile(candidate))
            return { path: candidate, source: 'AI_MEMORY_BIN' };
    }
    const p = de.platform === 'win32' ? path.win32 : path.posix;
    const exe = executableName(de.platform);
    const pathVar = envValue(de.env, de.platform, 'PATH') ?? '';
    const delimiter = de.platform === 'win32' ? ';' : ':';
    for (const entry of pathVar.split(delimiter)) {
        const dir = cleanPath(entry, de.home);
        if (dir === '' || !p.isAbsolute(dir))
            continue;
        const candidate = p.join(dir, exe);
        searched.push(candidate);
        if (de.isFile(candidate))
            return { path: candidate, source: 'PATH' };
    }
    for (const candidate of defaultLocations(de)) {
        if (searched.includes(candidate))
            continue;
        searched.push(candidate);
        if (de.isFile(candidate))
            return { path: candidate, source: 'default' };
    }
    return { error: `ai-memory executable not found (set config.binary or AI_MEMORY_BIN)`, searched };
}
