# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Native DSH plugin for ai-memory: lifecycle capture through the `ai-memory hook --agent dsh`
  command for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
  `PreCompact`, `SubagentStart`, `SubagentStop` and `SessionEnd`.
- The pending handoff is claimed at session start (`agent/created`, awaited before the first
  step) and injected into the first turn; with no handoff, a pointer to a cut-off session.
- Post-compaction anchor with the operator's prompts, injected after `compaction/end`.
- ai-memory tools as native DSH tools (`core`: 7 tools plus `memory_call`; `all`; `none`; or a
  list), each call scoped to the session's project through `ai-memory call`.
- A short ai-memory usage section in the system prompt.
- Cross-OS executable discovery (`AI_MEMORY_BIN`, `PATH`, per-OS installer locations), `\\?\`
  verbatim-path cleanup, shell-free spawning with hidden consoles on Windows, per-session
  ordered capture queues and a detached `SessionEnd` at shutdown.
