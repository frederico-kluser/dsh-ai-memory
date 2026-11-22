# dsh-ai-memory

[![CI](https://github.com/frederico-kluser/dsh-ai-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/frederico-kluser/dsh-ai-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that wires
[ai-memory](https://github.com/akitaonrails/ai-memory) natively. A DSH session then works with
ai-memory the way Claude Code does: the session is captured from start to end, the previous
session's handoff arrives in the first turn, a compaction is re-grounded with your own prompts,
and the model gets the memory tools. It runs the same on Windows, macOS and Linux, and never
goes through a shell.

## Why

ai-memory's own DSH integration goes through DSH's Claude Code hooks bridge
(`@deepseek-ai/dsh-hooks-claude-code` + a generated `hooks.json`). That path has hard gaps,
documented in ai-memory's support matrix:

| Gap with the hooks bridge | With dsh-ai-memory |
|---|---|
| No `SessionEnd`: sessions stay open until you run `ai-memory finalize-session --agent dsh`, and no automatic handoff is written | `agent/disposed` (and plugin shutdown) closes the session; ai-memory writes its automatic handoff |
| `SessionStart` runs detached, so ai-memory never claims the handoff for DSH: you have to ask for it | the handoff is claimed in `agent/created`, which DSH awaits before the first step, and injected into the first turn |
| No `PreCompact`, and nothing re-grounds the session after a compaction | `compaction/start` is captured; after `compaction/end` the operator's prompts are injected as an anchor |
| Windows: the hook command string runs through PowerShell (quoting broke it, ai-memory #2134); `\\?\` verbatim paths broke the bridge config and the MCP bridge (#2032, #2203) | the `ai-memory` executable is spawned with an argv array — no shell on any OS — and every path is cleaned of `\\?\` |
| MCP needs a hand-merged patch row and a long-lived bridge process per profile | the ai-memory tools are registered as native DSH tools, each call scoped to the session's own project |

## What it captures

Every event goes through the native `ai-memory hook --agent dsh` command, so ai-memory's capture
policy (`.ai-memory.toml` allowlists, exclusions), secret redaction and offline spool still apply.

| ai-memory event | DSH extension point |
|---|---|
| `SessionStart` (+ handoff claim) | `agent/created` (serial, awaited before the first step) |
| `UserPromptSubmit` | `agent/pre-step`, only messages the operator typed |
| `PreToolUse` / `PostToolUse` | `tools/pre-execute` / `tools/result` (the frozen final outcome) |
| `Stop` | `session/event` `turn/end` — completed, failed and interrupted turns |
| `PreCompact` (+ anchor) | `session/event` `compaction/start` / `compaction/end` |
| `SubagentStart` / `SubagentStop` | `subagent/start` / `subagent/end` |
| `SessionEnd` | `agent/disposed`, plus a detached process at DSH shutdown |

Capture never blocks the agent: each session has a serial queue (events stay in order), every
hook run has a timeout, and the startup handoff claim has a 6-second budget.

## Install

Requirements: ai-memory ≥ 3.5 installed with its server running (`ai-memory status`), and DSH 0.2.x.

```bash
dsh plugin --profile web add github:frederico-kluser/dsh-ai-memory
```

The package declares a DSH bundle, so `dsh plugin add` mounts it; do not also add a manual
`- insert:` row. Restart (or reload) the profile. Repeat for each profile you use (`headless`,
`tui`, …). When it is active, the profile's log (for `web`, `~/.dsh/logs/dsh-web.log`) shows
`[dsh-ai-memory] active — using <path to ai-memory>`; warnings use the same prefix. These lines go
to stderr only when it is redirected to a file or a pipe, so an interactive terminal UI is never
drawn over (`DSH_AI_MEMORY_VERBOSE=1` forces them, `DSH_AI_MEMORY_QUIET=1` silences them).

From a local checkout, point a profile patch at the built entry instead (and do not install the
package in that profile):

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-ai-memory
      name: '/path/to/dsh-ai-memory/lib/index.js'
```

### Coming from the hooks bridge

Remove the rows the ai-memory installer told you to merge, or events are captured twice:

- the `- id: ai-memory-hooks` row (`@deepseek-ai/dsh-hooks-claude-code`);
- optionally the `- id: 'ai-memory'` MCP-client row (`@deepseek-ai/dsh-mcp-client`). To keep it,
  set `tools: none` here so the model does not see the tools twice.

## Configuration

Every option is optional. To change one, restate the entry with a `config:` block in the
profile's `cordis.patch.yml`:

```yaml
- id: dsh-ai-memory
  config:
    tools: all
```

| Option | Default | Meaning |
|---|---|---|
| `binary` | discovered | Path to the ai-memory executable. Discovery order: `AI_MEMORY_BIN`, `PATH`, then `%LOCALAPPDATA%\Programs\ai-memory` (Windows), `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` |
| `dataDir` | ai-memory's | Passed as `--data-dir` (`AI_MEMORY_DATA_DIR` also works) |
| `serverUrl` | the install's | Hook server URL override |
| `agent` | `dsh` | Agent label recorded on sessions |
| `capture` | `true` | Capture lifecycle events |
| `captureTools` | `true` | Capture tool calls |
| `captureSubagents` | `true` | Report subagent start/stop edges |
| `captureSubagentSessions` | `false` | Also capture a subagent's child session as its own session |
| `handoff` | `true` | Claim the pending handoff at session start and inject it |
| `handoffSources` | `['startup', 'clear']` | Session-start sources that claim (`resume` is excluded, so reopening an old conversation never consumes a handoff) |
| `anchor` | `true` | Inject the post-compaction anchor |
| `tools` | `core` | `core`: 7 tools (`memory_query`, `memory_read_page`, `memory_handoff_begin`, `memory_handoff_accept`, `memory_handoff_list`, `memory_read_session_observations`, `memory_write_page`) plus `memory_call` for the other 20; `all`: all 27 as native tools (~20k tokens of schema); `none`; or a list of names |
| `instructions` | `true` | Add a short ai-memory usage section to the system prompt |
| `hookTimeoutMs` | `15000` | Timeout of one capture hook |
| `startupTimeoutMs` | `6000` | Budget of the startup handoff claim |
| `toolTimeoutMs` | `60000` | Timeout of one tool call |

## How it works

- **No shell.** `ai-memory` is spawned with `shell: false` and an argv array, with the console
  window hidden on Windows. Nothing parses `"`, `\`, `$`, `%`, `&` or `|` in prompts, paths or
  JSON arguments.
- **ai-memory owns credentials and routing.** Tools, the handoff claim and the anchor all run
  `ai-memory call <tool>` in the session's working directory, so ai-memory resolves the server,
  the bearer token (environment, `auth-token`, OIDC, server profiles) and the project itself.
  The plugin never reads a token.
- **Untrusted history stays fenced.** Injected handoffs and anchors use ai-memory's own
  `<!-- ai-memory:untrusted-history -->` fences and security notice, and stored text cannot
  close the fence early.
- **One spelling per directory.** On Windows the session directory is normalized (backslashes,
  no `\\?\`, upper-case drive letter) so ai-memory matches handoffs written by other agents.
- **Fails open.** A missing executable, a stopped server or a slow hook is logged once and the
  session continues; nothing in this plugin can stop DSH from booting or a turn from running.

## Verify

After one DSH session in a project:

```bash
ai-memory call memory_briefing '{"recent_sessions_limit": 3}'   # the session, agent "dsh", ended: true
ai-memory call memory_handoff_list '{}'                         # the automatic handoff it left
```

Start a new DSH session in the same project and ask "where did we leave off?": the answer comes
from the injected `📥 ai-memory: pending handoff` block.

## Development

```bash
npm ci
npm test             # unit tests (node:test), fake ai-memory, no network
npm run build        # rebuild lib/ (committed, so installs never build)
npm run check:lib    # CI: lib/ must match the sources
node test/live/live.mjs   # against a real ai-memory server
npm run test:e2e -- --dsh-root /path/to/deepseek-harness   # against a real DSH + ai-memory
```

CI runs the unit tests on Linux, macOS and Windows (Node 22 and 24) and the live test against the
real ai-memory release binary on all three systems. The end-to-end test boots a real DSH headless
profile from an isolated `DSH_HOME`, with a keyless mock model, in a fresh git repository, and
purges its ai-memory project at the end.

## Limitations

- A DSH process killed without a chance to shut down (`kill -9`, a crash) cannot send
  `SessionEnd`; `ai-memory recover` or `ai-memory finalize-session --agent dsh` closes it.
- On Windows one tool call's JSON arguments must fit the 32 767-character command line; split very
  large page writes with `memory_patch_page` or `memory_write_pages_batch`.
- A subagent's child session is not captured as its own session by default
  (`captureSubagentSessions`), matching ai-memory's default of dropping subagent captures.

## License

[MIT](LICENSE)
