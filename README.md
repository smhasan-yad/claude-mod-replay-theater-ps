# claude-mod-replay-theater-ps

`/replay` steps through every file change of the last turn, one diff at a time, including changes made by PowerShell and Bash commands. Port of Anthropic's Replay Theater sample mod.

## Install

```bash
claude plugin marketplace add smhasan-yad/claude-mod-replay-theater-ps
claude plugin install replay-theater-ps@claude-mod-replay-theater-ps
```

A new chat or /reload-plugins picks it up. Written for the Windows desktop app and terminal (Claude Code mods API); not tested elsewhere.

## License

Apache-2.0. Derived from Anthropic's sample mod (Copyright 2026 Anthropic PBC, Apache-2.0). Changes: PowerShell/Windows support. Original file headers are kept.
