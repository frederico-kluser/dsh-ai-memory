/**
 * Path hygiene shared by every OS.
 *
 * ai-memory canonicalizes its data dir with Rust's `fs::canonicalize`, which on
 * Windows yields verbatim paths (`\\?\C:\...`). Node and the DSH bridge could
 * not open those (ai-memory issues #2032 and #2203): the prefix was read as a
 * relative path. Every path this plugin receives from configuration or the
 * environment goes through {@link cleanPath} before use.
 * @module paths
 */
import { homedir } from 'node:os';
import path from 'node:path';
/**
 * Remove a Windows verbatim prefix: `\\?\C:\x` → `C:\x`,
 * `\\?\UNC\host\share\x` → `\\host\share\x`. The forward-slash spellings
 * (`//?/C:/x`) are handled too. Any other path is returned unchanged.
 * @param path - a path that may carry the prefix.
 * @returns the same path without it.
 */
export function stripVerbatimPrefix(path) {
    const unc = /^[\\/]{2}\?[\\/]UNC[\\/]/i;
    if (unc.test(path))
        return `\\\\${path.replace(unc, '')}`;
    const drive = /^[\\/]{2}\?[\\/](?=[A-Za-z]:)/;
    if (drive.test(path))
        return path.replace(drive, '');
    return path;
}
/**
 * Expand a leading `~` (alone, `~/x` or `~\x`) to the user's home directory.
 * @param path - the path to expand.
 * @param home - the home directory (injectable for tests).
 * @returns the expanded path.
 */
export function expandHome(path, home = homedir()) {
    if (path === '~')
        return home;
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return home + path.slice(1);
    return path;
}
/**
 * A session directory as ai-memory should see it. ai-memory compares handoff
 * directories as strings, so the same folder must always be spelled the same
 * way: on Windows that is backslashes, no verbatim prefix and an upper-case
 * drive letter (what Claude Code and Codex report); elsewhere the path is
 * left as DSH gave it, minus a trailing separator.
 * @param cwd - the directory DSH reported.
 * @param platform - the OS (injectable for tests).
 * @returns the normalized directory.
 */
export function normalizeCwd(cwd, platform = process.platform) {
    if (platform === 'win32') {
        let value = path.win32.normalize(stripVerbatimPrefix(cwd));
        if (/^[a-z]:/.test(value))
            value = value[0].toUpperCase() + value.slice(1);
        if (value.length > 3 && value.endsWith('\\'))
            value = value.slice(0, -1);
        return value;
    }
    return cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
}
/**
 * Trim, strip surrounding quotes (a Windows `PATH` entry may carry them),
 * expand `~` and drop a verbatim prefix.
 * @param path - a configured or discovered path.
 * @param home - the home directory (injectable for tests).
 * @returns the cleaned path, or `''` for a blank input.
 */
export function cleanPath(path, home) {
    let value = path.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1).trim();
    if (value === '')
        return '';
    return stripVerbatimPrefix(expandHome(value, home));
}
