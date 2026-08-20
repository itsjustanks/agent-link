# agent-auth

**Run multiple Claude Code and Codex accounts on one machine — in parallel, or hot-switched — without ever copying a credential.**

If you have more than one Claude Max / ChatGPT subscription (personal + work, two companies, a team pool), the CLIs give you one login each. Account-switcher apps work by backing up your OAuth tokens and swapping them in and out — which breaks in two well-known ways:

1. **Codex backups die.** ChatGPT OAuth rotates the refresh token on every refresh, so a stored backup goes stale the moment the live session refreshes. Restoring it later gets you "login required".
2. **Swaps yank sessions out from under running agents.** Replace the live credential file while an agent is mid-task and it dies with "failed to authenticate / session expired".

`agent-auth` avoids both by never moving credentials at all. Each account gets its own **slot** — a folder named by the account email — holding its own live credential store (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex). Every slot's tokens refresh themselves in place, forever. Your original `~/.claude` and `~/.codex` are untouched and keep working as the "primary".

Works on **macOS and Linux**. Plain bash + python3, no Keychain, no daemon, no dependencies.

## Install

```sh
git clone https://github.com/YOURNAME/agent-auth
cp agent-auth/agent-auth ~/.local/bin/ && chmod +x ~/.local/bin/agent-auth
```

## Quickstart

```sh
agent-auth                 # interactive mode — walks you through everything
```

or directly:

```sh
agent-auth add claude you@work.com     # create a slot + browser login
agent-auth add claude you@home.com
agent-auth add codex  you@work.com
agent-auth status                      # who's logged in where
```

After each login, agent-auth verifies the signed-in email matches the slot's folder name and flags `WRONG ACCOUNT` if the browser signed you into the wrong one (tip: use a private window per account — the OAuth pages reuse whatever web session your browser already has).

## Use accounts in parallel

Every slot is independently usable — N accounts means N rate-limit pools running at the same time.

```sh
agent-auth shims           # writes claude-1, claude-2, codex-1 ... shims
claude-2                   # a full Claude Code, logged in as slot #2
```

Or for scripts and orchestrators:

```sh
agent-auth run claude you@work.com claude -p "hello"
eval "$(agent-auth env claude you@work.com)"    # exports CLAUDE_CONFIG_DIR for this shell
```

### Paseo / orchestrator integration

Point a custom provider at a slot and it becomes a separate, parallel quota pool:

```jsonc
// ~/.paseo/config.json → agents.providers
"claude-work": {
  "extends": "claude",
  "label": "Claude · you@work.com",
  "env": { "CLAUDE_CONFIG_DIR": "/home/you/.agent-auth/accounts/claude/you@work.com" }
}
```

## Hot-switch the plain `claude` / `codex` commands

```sh
agent-auth route enable            # writes router shims to ~/.agent-auth/bin
export PATH="$HOME/.agent-auth/bin:$PATH"   # add to your shell profile

agent-auth use claude you@work.com # plain `claude` is now you@work.com
agent-auth use claude 2            # ...or pick by slot number
agent-auth use claude primary      # ...back to your original ~/.claude login
```

The switch is a one-line pointer file, not a credential swap:

- nothing is backed up or restored, so **no token decay, ever** — including Codex
- it affects **new processes only** — agents already running keep the account they started with, so a switch can never kill a session mid-task
- `primary` routes straight through to your untouched `~/.claude` / `~/.codex`
- `agent-auth route disable` removes the shims; you're back to stock in one command

## All commands

```
agent-auth                       interactive mode
agent-auth status                every slot, login state, and routing
agent-auth add <prov> <email>    create a slot and log it in
agent-auth login [prov] [email|all]      (re)login anything that needs it
agent-auth use <prov> <email|N|primary>  hot-switch plain claude/codex
agent-auth route enable|disable|status   manage router shims
agent-auth shims                 numbered per-slot shims (claude-1, ...)
agent-auth env <prov> <email>    eval-able export for one slot
agent-auth run <prov> <email> [cmd...]   run anything under a slot
agent-auth sync                  copy MCP servers + project trust from primary claude into slots
agent-auth doctor                sanity checks
```

## How it works (and what it never does)

- A slot is just the CLI's own config dir, relocated: Claude Code reads `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`. The CLIs manage their own credentials inside the slot — agent-auth **never reads, writes, copies, or backs up a token**.
- Setting `CLAUDE_CONFIG_DIR` makes Claude Code use a file-based credential store inside the slot (instead of the OS keychain), which is what makes slots portable and self-contained — on Linux and macOS alike.
- Codex slots are pinned to `cli_auth_credentials_store = "file"` in the slot's `config.toml` so credentials stay inside `CODEX_HOME`.
- `agent-auth sync` copies **definitions only** (MCP server configs, trusted-project flags) from your primary `~/.claude.json` into slots — never `oauthAccount`, never credentials.
- Identity verification reads only the account email (from the slot's own config / ID-token claim) to catch wrong-account logins.
- Slot storage is as sensitive as `~/.claude` itself — same machine, same user, same file permissions (`0600` for synced configs).

## Uninstall

```sh
agent-auth route disable
rm -rf ~/.agent-auth ~/.local/bin/agent-auth
```

Your primary logins were never touched, so there is nothing to restore.

## License

MIT
