# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Sections are generated from the
Conventional Commits since the previous tag.

## [Unreleased]

## [0.1.1] - 2026-11-21

### Bug Fixes
- mostra ativação e avisos no log do DSH web (#3) ([aeec85e](https://github.com/frederico-kluser/dsh-ai-memory/commit/aeec85e))

### Tests
- **e2e:** valida o pacote publicado com --install (#2) ([e29222d](https://github.com/frederico-kluser/dsh-ai-memory/commit/e29222d))

## [0.1.0] - 2026-11-21

### Features
- plugin nativo do ai-memory para o DeepSeek Harness ([617bfe9](https://github.com/frederico-kluser/dsh-ai-memory/commit/617bfe9))

  - Lifecycle capture through the native `ai-memory hook --agent dsh` command for
    `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`,
    `SubagentStart`, `SubagentStop` and `SessionEnd`, in one ordered queue per session.
  - The pending handoff is claimed in `agent/created` (awaited before the first step) and
    injected into the first turn; with no handoff, a pointer to a cut-off session.
  - Post-compaction anchor with the operator's prompts, injected after `compaction/end`.
  - ai-memory tools as native DSH tools (`core`: 7 tools plus `memory_call`; `all`; `none`;
    or a list), each call scoped to the session's project through `ai-memory call`.
  - A short ai-memory usage section in the system prompt.
  - Windows: shell-free argv spawning (ai-memory #2134), `\\?\` verbatim-path cleanup
    (#2032, #2203), hidden consoles, one spelling per session directory.
  - Cross-OS executable discovery (`AI_MEMORY_BIN`, `PATH`, per-OS installer locations) and a
    detached `SessionEnd` at DSH shutdown.

[Unreleased]: https://github.com/frederico-kluser/dsh-ai-memory/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/frederico-kluser/dsh-ai-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/frederico-kluser/dsh-ai-memory/releases/tag/v0.1.0
