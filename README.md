# agent-link

**Run multiple Claude Code and Codex accounts on one machine — in parallel, or hot-switched — without ever copying a credential.**

If you have more than one Claude Max / ChatGPT subscription (personal + work, two companies, a team pool), the CLIs give you one login each. Account-switcher apps work by backing up your OAuth tokens and swapping them in and out — which breaks in two well-known ways:

1. **Codex backups die.** ChatGPT OAuth rotates the refresh token on every refresh, so a stored backup goes stale the moment the live session refreshes. Restoring it later gets you "login required".
2. **Swaps yank sessions out from under running agents.** Replace the live credential file while an agent is mid-task and it dies with "failed to authenticate / session expired".

`agent-link` avoids both by never moving credentials at all. Each account gets its own **slot** — a folder named by the account email — holding its own live credential store (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex). Every slot's tokens refresh themselves in place, forever. Your original `~/.claude` and `~/.codex` are untouched and keep working as the "primary".

Works on **macOS and Linux**. Plain bash + python3, no Keychain, no daemon, no dependencies.

## Requirements

- bash and python3 (both preinstalled on macOS and Ubuntu)
- whichever CLIs you want to manage — either or both:
  - Claude Code: `npm install -g @anthropic-ai/claude-code` (a recent version; `claude auth login` is used for clean logins, older versions fall back to the interactive REPL)
  - Codex: `npm install -g @openai/codex`
- You do **not** need to be logged into the primary CLI first. Existing logins are left alone; missing CLIs are detected with install hints rather than half-created slots.

If `claude` only works in your shell through an alias (the old migrate-installer), run `claude install` once so a real binary is on PATH — scripts and shims can't see aliases.

## Install

It is a single file with no dependencies beyond bash and python3:

```sh
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/itsjustanks/agent-link/main/agent-link -o ~/.local/bin/agent-link
chmod +x ~/.local/bin/agent-link
agent-link            # opens the dashboard
```

If you already used the tool as `agent-auth`, keep that name working:

```sh
ln -sf agent-link ~/.local/bin/agent-auth
```

Existing setups keep working untouched: agent-link uses whichever home directory already holds your accounts (`~/.agent-auth` from before the rename, or `~/.agent-link`), and both `AGENT_AUTH_HOME` and `AGENT_LINK_HOME` are honoured.

> **Do not move or rename your accounts directory.** Claude Code binds each login to the literal config-dir path, so moving it silently logs out every Claude account (Codex survives, since its credentials are files inside the folder). If you must move it, plan on `agent-link login all` afterwards. This is also why routing uses a launcher rather than a symlink.

Make sure `~/.local/bin` is on your `PATH`. To update, run the same curl again. To uninstall, delete that file (and `~/.agent-link` if you want the slots gone too).

<details><summary>Prefer git?</summary>

```sh
git clone https://github.com/itsjustanks/agent-link
cp agent-link/agent-link ~/.local/bin/ && chmod +x ~/.local/bin/agent-link
```
</details>

## Quickstart

```sh
agent-link                 # interactive dashboard — walks you through everything
```

It opens on a live view of every account (logged in · in rotation · parked · wrong account), where the plain `claude`/`codex` command points, and whether dynamic routing is set up — with one-key actions grouped underneath:

```
  CLAUDE                              plain `claude` → primary
    ● you@work.com                   logged in      in rotation · used 3m ago
    ● you@home.com                   logged in      parked 45m — routing skips it
    ○ new@example.com                not logged in  run 'l' to log in
    dynamic routing: ready (~/.agent-link/bin/claude-auto)

  ACCOUNTS  a add · l log in what needs it · r remove
  ROUTING   d dynamic router · u pin plain command · s numbered shims
  POOLS     p park an account · k unpark
  UPKEEP    y sync MCP + trust · ? doctor · q quit
```

Colour is used when the terminal supports it and skipped under `NO_COLOR` or when piped, so `agent-link status` stays readable in scripts and CI.

or directly:

```sh
agent-link add claude you@work.com     # create a slot + browser login
agent-link add claude you@home.com
agent-link add codex  you@work.com
agent-link status                      # who's logged in where
```

After each login, agent-link verifies the signed-in email matches the slot's folder name and flags `WRONG ACCOUNT` if the browser signed you into the wrong one (tip: use a private window per account — the OAuth pages reuse whatever web session your browser already has).

## Use accounts in parallel

Every slot is independently usable — N accounts means N rate-limit pools running at the same time.

```sh
agent-link shims           # writes claude-1, claude-2, codex-1 ... shims
claude-2                   # a full Claude Code, logged in as slot #2
```

Or for scripts and orchestrators:

```sh
agent-link run claude you@work.com claude -p "hello"
eval "$(agent-link env claude you@work.com)"    # exports CLAUDE_CONFIG_DIR for this shell
```

### Use with Paseo (multi-agent orchestration)

If you run agents through [Paseo](https://paseo.sh), each slot can become its own provider — so five agents on three Claude accounts genuinely run on three separate rate limits, in parallel, with no switching.

> **Prefer a UI?** [**paseo-agent-superpowers**](https://github.com/itsjustanks/paseo-agent-superpowers) is a Paseo plugin that does all of the below with one click — account slots with login status, provider wiring, health checks, and a universal MCP manager across Claude Code, Codex, Kimi, and Grok. agent-link is the CLI underneath it; each works without the other.

**1. Create and log in your slots** (see Quickstart), then grab each slot's exact path:

```sh
agent-link env claude you@work.com
# export CLAUDE_CONFIG_DIR="/home/you/.agent-link/accounts/claude/you@work.com"
```

**2. Add one custom provider per slot** to `~/.paseo/config.json` under `agents.providers`. `extends` reuses Paseo's native Claude/Codex integration; only the credential dir changes:

```jsonc
"agents": {
  "providers": {
    "claude-work": {
      "extends": "claude",
      "label": "Claude · you@work.com",
      "env": { "CLAUDE_CONFIG_DIR": "/home/you/.agent-link/accounts/claude/you@work.com" }
    },
    "claude-personal": {
      "extends": "claude",
      "label": "Claude · you@home.com",
      "env": { "CLAUDE_CONFIG_DIR": "/home/you/.agent-link/accounts/claude/you@home.com" }
    },
    "codex-work": {
      "extends": "codex",
      "label": "Codex · you@work.com",
      "env": { "CODEX_HOME": "/home/you/.agent-link/accounts/codex/you@work.com" }
    }
  }
}
```

Keep provider **ids** as plain slugs (`claude-work`, not the email — ids travel through CLIs and URLs where `@` misbehaves) and put the email in the **label**, which is what Paseo's UI shows.

**3. Restart the Paseo daemon.** Paseo builds its provider registry at startup, so new providers don't appear until a restart (`paseo restart`, or quit and reopen the app). Do it when no agents are mid-task.

**4. Use them.** The new providers show up in Paseo's provider picker with the same models as the builtin — spawn each heavy agent on a different pool. Your builtin `claude`/`codex` providers keep using the primary login, untouched.

### Any other tool (custom providers, editors, CI)

Anything that lets you configure **a command** or **environment variables** can use agent-link. Two patterns cover everything:

| You can set… | Use | Result |
| --- | --- | --- |
| a command | `~/.agent-link/bin/claude-auto` | one entry, rotates across all accounts |
| a command | `~/.agent-link/bin/claude-1`, `claude-2`, … | one entry pinned to account #N |
| env vars | `CLAUDE_CONFIG_DIR=~/.agent-link/accounts/claude/<email>` | pinned to that account |
| neither | wrap the call in `agent-link claude …` | rotates across all accounts |

`CODEX_HOME` is the Codex equivalent of `CLAUDE_CONFIG_DIR`. Any of these can be mixed — a rotating entry for bulk work plus a pinned one for a job that must stay on a named account.

## Run any command on the next account

The quickest way to use several accounts without configuring anything:

```sh
agent-link claude              # Claude Code on the next account in rotation
agent-link codex               # same for Codex
agent-link claude -p "hello"   # arguments pass straight through
```

Each invocation picks the least-recently-used account that is logged in and not parked. If you set `CLAUDE_CONFIG_DIR`/`CODEX_HOME` yourself it is respected, and if no account is available it just runs your primary login.

## Auto-routing: one provider, all your accounts

Instead of picking an account per agent, point **one** provider at an auto launcher and every new process lands on a live account:

```sh
agent-link auto        # writes ~/.agent-link/bin/claude-auto and codex-auto
agent-link pools       # see what it will choose from
```

Each launch picks the **least-recently-used** account that is logged in and not cooling down, then execs the real CLI with that account's config dir. A running process is never re-routed — it keeps the account it started with for its whole life.

When an account hits its usage limit, park it and auto-routing skips it:

```sh
agent-link cooldown claude you@work.com 180     # skip for 3 hours
agent-link cooldown claude you@work.com clear
```

An explicitly set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` always wins, so `agent-link run`, per-account shims, and pinned providers keep working exactly as before.

`agent-link auto` prints a ready-to-paste Paseo provider snippet — one `Claude (Dynamic Agent Link)` provider that spreads agents across every account you own.

> Two notes: run `agent-link auto` from your **installed** copy (e.g. `~/.local/bin/agent-link`) — each launcher records the path of the agent-link that created it, so generating them from a temporary clone ties them to that clone. If that path ever disappears the launcher simply falls back to your primary account rather than failing.
>
> And this has to be a launcher, not a symlink: Claude Code keys credentials to the literal config-dir path, so a symlink that swings between accounts reports "logged out".

## Hot-switch the plain `claude` / `codex` commands

```sh
agent-link route enable            # writes router shims to ~/.agent-link/bin
export PATH="$HOME/.agent-link/bin:$PATH"   # add to your shell profile

agent-link use claude you@work.com # plain `claude` is now you@work.com
agent-link use claude 2            # ...or pick by slot number
agent-link use claude primary      # ...back to your original ~/.claude login
```

The switch is a one-line pointer file, not a credential swap:

- nothing is backed up or restored, so **no token decay, ever** — including Codex
- it affects **new processes only** — agents already running keep the account they started with, so a switch can never kill a session mid-task
- `primary` routes straight through to your untouched `~/.claude` / `~/.codex`
- `agent-link route disable` removes the shims; you're back to stock in one command

## All commands

```
agent-link                       interactive mode
agent-link status                every slot, login state, and routing
agent-link add <prov> <email>    create a slot and log it in
agent-link login [prov] [email|all]      (re)login anything that needs it
agent-link use <prov> <email|N|primary>  hot-switch plain claude/codex
agent-link route enable|disable|status   manage router shims
agent-link shims                 numbered per-slot shims (claude-1, ...)
agent-link auto                  auto-routing launchers (one provider, many accounts)
agent-link pools                 what auto-routing sees: available / cooling down / last used
agent-link cooldown <prov> <email> [min|clear]   park an exhausted account
agent-link env <prov> <email>    eval-able export for one slot
agent-link run <prov> <email> [cmd...]   run anything under a slot
agent-link remove <prov> <email> delete a slot and its login
agent-link sync                  copy MCP servers + project trust from primaries into slots
agent-link doctor                sanity checks
```

## Headless servers (Ubuntu, VPS, containers)

agent-link itself is just bash + python3 and runs anywhere. The only interactive part is each account's one-time browser OAuth:

- `claude auth login` prints a URL you can open in any browser (your laptop) and paste the code back into the SSH session.
- `codex login` listens on localhost during the flow — forward it once: `ssh -L 1455:localhost:1455 you@server`, then open the printed URL locally.

After that one-time login per slot, tokens refresh in place unattended — servers, cron agents, and orchestrator daemons keep working without a browser ever again.

## Troubleshooting

- **Login opened the browser on the wrong account** — the OAuth pages reuse whatever session your browser already has. Paste the login URL into a private/incognito window (one per account) or keep a browser profile per account. agent-link flags `WRONG ACCOUNT` after login, so a mix-up can't go unnoticed.
- **First interactive run of a new slot asks onboarding questions** (theme etc.) — normal for a fresh config dir; `agent-link sync` copies the onboarding flags from your primary to skip most of it.
- **`agent-link: real 'claude' binary not found in PATH`** — the router shim needs a real binary somewhere later in PATH. If claude is alias-installed, run `claude install`.

## MCP servers across accounts

Each slot has its own MCP configuration (that's just how the CLIs work — Claude Code keeps it in the config dir's `.claude.json`, Codex in `config.toml`). `agent-link sync` keeps slots consistent with your primary:

- **claude slots** get the primary's MCP server *definitions* and trusted-project flags copied into their `.claude.json`
- **codex slots** get the primary's `config.toml` re-copied (MCP servers live there), with the file-store pin re-applied

Two classes of MCP server behave differently after a sync:

- Servers whose credentials are **in the definition** (API key in env/header): work in every slot immediately.
- **OAuth-based** MCP servers: their tokens live in each slot's own credential store, tied to that slot's account. That is not an agent-link limitation to work around — sharing OAuth tokens across accounts is exactly the credential-copying this tool exists to avoid (and it breaks anyway when servers rotate refresh tokens). Each slot authorizes those once, in place, and they refresh in place forever after — same rule as the account login itself.

Run `agent-link sync` again whenever you add MCP servers or trust new projects on the primary.

## How it works (and what it never does)

- A slot is just the CLI's own config dir, relocated: Claude Code reads `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`. The CLIs manage their own credentials inside the slot — agent-link **never reads, writes, copies, or backs up a token**.
- `CLAUDE_CONFIG_DIR` gives Claude Code a separate credential store per slot. On macOS the tokens live in the OS keychain keyed by that config dir (not in the slot folder); on Linux they are written inside the slot. Either way the slots are independent — verified by three config dirs reporting three different `claude auth status` accounts at the same time. (A slot folder therefore looks "empty" on macOS even when logged in; agent-link judges login state by the account recorded in the slot, not by a credentials file.)
- Codex slots are pinned to `cli_auth_credentials_store = "file"` in the slot's `config.toml` so credentials stay inside `CODEX_HOME`.
- `agent-link sync` copies **definitions only** (MCP server configs, trusted-project flags) from your primary `~/.claude.json` into slots — never `oauthAccount`, never credentials.
- Identity verification reads only the account email (from the slot's own config / ID-token claim) to catch wrong-account logins.
- Slot storage is as sensitive as `~/.claude` itself — same machine, same user, same file permissions (`0600` for synced configs).

## Uninstall

```sh
agent-link route disable
rm -rf ~/.agent-link ~/.local/bin/agent-link
```

Your primary logins were never touched, so there is nothing to restore.

## License

MIT
