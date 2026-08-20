# agent-auth

**Run multiple Claude Code and Codex accounts on one machine — in parallel, or hot-switched — without ever copying a credential.**

If you have more than one Claude Max / ChatGPT subscription (personal + work, two companies, a team pool), the CLIs give you one login each. Account-switcher apps work by backing up your OAuth tokens and swapping them in and out — which breaks in two well-known ways:

1. **Codex backups die.** ChatGPT OAuth rotates the refresh token on every refresh, so a stored backup goes stale the moment the live session refreshes. Restoring it later gets you "login required".
2. **Swaps yank sessions out from under running agents.** Replace the live credential file while an agent is mid-task and it dies with "failed to authenticate / session expired".

`agent-auth` avoids both by never moving credentials at all. Each account gets its own **slot** — a folder named by the account email — holding its own live credential store (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex). Every slot's tokens refresh themselves in place, forever. Your original `~/.claude` and `~/.codex` are untouched and keep working as the "primary".

Works on **macOS and Linux**. Plain bash + python3, no Keychain, no daemon, no dependencies.

## Requirements

- bash and python3 (both preinstalled on macOS and Ubuntu)
- whichever CLIs you want to manage — either or both:
  - Claude Code: `npm install -g @anthropic-ai/claude-code` (a recent version; `claude auth login` is used for clean logins, older versions fall back to the interactive REPL)
  - Codex: `npm install -g @openai/codex`
- You do **not** need to be logged into the primary CLI first. Existing logins are left alone; missing CLIs are detected with install hints rather than half-created slots.

If `claude` only works in your shell through an alias (the old migrate-installer), run `claude install` once so a real binary is on PATH — scripts and shims can't see aliases.

## Install

```sh
git clone https://github.com/itsjustanks/agent-auth
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

### Use with Paseo (multi-agent orchestration)

If you run agents through [Paseo](https://paseo.sh), each slot can become its own provider — so five agents on three Claude accounts genuinely run on three separate rate limits, in parallel, with no switching.

**1. Create and log in your slots** (see Quickstart), then grab each slot's exact path:

```sh
agent-auth env claude you@work.com
# export CLAUDE_CONFIG_DIR="/home/you/.agent-auth/accounts/claude/you@work.com"
```

**2. Add one custom provider per slot** to `~/.paseo/config.json` under `agents.providers`. `extends` reuses Paseo's native Claude/Codex integration; only the credential dir changes:

```jsonc
"agents": {
  "providers": {
    "claude-work": {
      "extends": "claude",
      "label": "Claude · you@work.com",
      "env": { "CLAUDE_CONFIG_DIR": "/home/you/.agent-auth/accounts/claude/you@work.com" }
    },
    "claude-personal": {
      "extends": "claude",
      "label": "Claude · you@home.com",
      "env": { "CLAUDE_CONFIG_DIR": "/home/you/.agent-auth/accounts/claude/you@home.com" }
    },
    "codex-work": {
      "extends": "codex",
      "label": "Codex · you@work.com",
      "env": { "CODEX_HOME": "/home/you/.agent-auth/accounts/codex/you@work.com" }
    }
  }
}
```

Keep provider **ids** as plain slugs (`claude-work`, not the email — ids travel through CLIs and URLs where `@` misbehaves) and put the email in the **label**, which is what Paseo's UI shows.

**3. Restart the Paseo daemon.** Paseo builds its provider registry at startup, so new providers don't appear until a restart (`paseo restart`, or quit and reopen the app). Do it when no agents are mid-task.

**4. Use them.** The new providers show up in Paseo's provider picker with the same models as the builtin — spawn each heavy agent on a different pool. Your builtin `claude`/`codex` providers keep using the primary login, untouched.

The same `env`-var pattern works for any other orchestrator or script runner: anything that lets you set `CLAUDE_CONFIG_DIR`/`CODEX_HOME` per process can target a slot (or wrap it with `agent-auth run`).

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
agent-auth remove <prov> <email> delete a slot and its login
agent-auth sync                  copy MCP servers + project trust from primaries into slots
agent-auth doctor                sanity checks
```

## Troubleshooting

- **Login opened the browser on the wrong account** — the OAuth pages reuse whatever session your browser already has. Paste the login URL into a private/incognito window (one per account) or keep a browser profile per account. agent-auth flags `WRONG ACCOUNT` after login, so a mix-up can't go unnoticed.
- **First interactive run of a new slot asks onboarding questions** (theme etc.) — normal for a fresh config dir; `agent-auth sync` copies the onboarding flags from your primary to skip most of it.
- **`agent-auth: real 'claude' binary not found in PATH`** — the router shim needs a real binary somewhere later in PATH. If claude is alias-installed, run `claude install`.

## MCP servers across accounts

Each slot has its own MCP configuration (that's just how the CLIs work — Claude Code keeps it in the config dir's `.claude.json`, Codex in `config.toml`). `agent-auth sync` keeps slots consistent with your primary:

- **claude slots** get the primary's MCP server *definitions* and trusted-project flags copied into their `.claude.json`
- **codex slots** get the primary's `config.toml` re-copied (MCP servers live there), with the file-store pin re-applied

Two classes of MCP server behave differently after a sync:

- Servers whose credentials are **in the definition** (API key in env/header): work in every slot immediately.
- **OAuth-based** MCP servers: their tokens live in each slot's own credential store, tied to that slot's account. That is not an agent-auth limitation to work around — sharing OAuth tokens across accounts is exactly the credential-copying this tool exists to avoid (and it breaks anyway when servers rotate refresh tokens). Each slot authorizes those once, in place, and they refresh in place forever after — same rule as the account login itself.

Run `agent-auth sync` again whenever you add MCP servers or trust new projects on the primary.

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
