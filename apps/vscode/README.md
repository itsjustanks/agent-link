# VS Code / Cursor

There is nothing to install. Both editors run the CLIs as a subprocess, so point
them at an agent-link launcher and every new session uses a healthy account.

**Rotating across all accounts** — set the Claude Code command (or Cursor's
equivalent) to:

```
~/.agent-link/bin/claude-auto
```

**Pinned to one account** — use a numbered shim (`claude-1`, `claude-2`, written
by `agent-link shims`), or set the environment variable for the workspace:

```jsonc
// .vscode/settings.json
{ "terminal.integrated.env.osx": {
    "CLAUDE_CONFIG_DIR": "/Users/you/.agent-link/accounts/claude/you@work.com"
} }
```

Anything launched from that terminal — including the CLI and editor extensions
that shell out to it — then uses that account.
