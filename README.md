# agent-link

**Use all your Claude Code and Codex accounts from one machine — automatically, without ever copying a credential.**

```
  CLAUDE                              plain `claude` → primary
    ● you@work.com                   primary        in rotation · 12 launches
    ● you@home.com                   logged in      in rotation · 9 launches · last 4m ago
    ● you@side.com                   logged in      spend limit reached — routing skips it
    dynamic routing: ready (~/.agent-link/bin/claude-auto)
```

Three things it does:

1. **Runs several accounts side by side.** Each account gets its own credential store, so they are live simultaneously — N accounts, N rate limits.
2. **Routes automatically.** One command (or one editor provider) sends each new agent to the least-recently-used healthy account, and skips any that is parked or out of credit.
3. **Never moves credentials.** No backup/restore, so nothing decays and no running session is ever logged out — the failure mode of account-switcher apps.

Works on **macOS and Linux**. One bash file, no dependencies beyond `python3`. MIT.

---

## Install

```sh
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/itsjustanks/agent-link/main/agent-link -o ~/.local/bin/agent-link
chmod +x ~/.local/bin/agent-link
```

Make sure `~/.local/bin` is on your `PATH`. Re-run the curl to update; delete the file to uninstall.

You need whichever CLIs you want to manage — [Claude Code](https://claude.com/claude-code) (`npm i -g @anthropic-ai/claude-code`) and/or [Codex](https://github.com/openai/codex) (`npm i -g @openai/codex`). You do not need to be logged into them first.

## Quickstart

```sh
agent-link                              # interactive dashboard
agent-link add claude you@work.com      # create an account slot + sign in
agent-link add claude you@home.com
agent-link auto                         # enable automatic routing
agent-link claude                       # Claude Code on the next account in rotation
```

`agent-link status` shows every account: signed in, in rotation, parked, out of credit, or the wrong account signed into a slot.

## The three ways to use it

| You want | Use | Behaviour |
| --- | --- | --- |
| Spread work across all accounts | `agent-link claude` · or point a provider at `~/.agent-link/bin/claude-auto` | Each launch takes the least-recently-used healthy account |
| One specific account | `agent-link run claude you@work.com claude` · or the `claude-1`, `claude-2` shims | Always that account |
| Change what plain `claude` uses | `agent-link use claude you@work.com` | A pointer file; affects new processes only |

`CODEX_HOME` / `codex` work identically to `CLAUDE_CONFIG_DIR` / `claude` throughout.

## Automatic routing

```sh
agent-link auto        # write the launchers
agent-link status      # who is in rotation, and why anyone is not
```

Rotation includes your **primary** login as well as every added account, so you never duplicate an account you already use. An account is skipped when it is **parked** (`agent-link cooldown claude you@work.com 180`, `… clear` to unpark) or **not signed in**.

### Not every account can serve every model

An account can be signed in and healthy yet still refuse a specific model — a spend limit applies per account, and premium models are the first thing to go. The CLI's own config flags do **not** predict this reliably (an account marked "out of credits" may serve fine while another that looks healthy refuses), so measure it:

```sh
agent-link probe claude claude-fable-5 --park
#   you@work.com     ok
#   you@side.com     CANNOT SERVE claude-fable-5
#       parked for 180m — routing will skip it
```

Each account answers one token on that model; `--park` sidelines the ones that refuse, so rotation stops sending them work. Re-run it when limits reset.

Two guarantees that make this safe:

- **A running process is never re-routed.** Routing happens at launch; nothing switches under a live session.
- **Resumes stay on their own account.** A conversation only exists inside the account that created it, so `--resume <id>` is pinned to whichever account holds that session — including your **primary**, which owns every conversation started before you added accounts. (Without this you get *"No conversation found with session ID"*.)

### When an account hits its limit mid-conversation

Be clear about what is and is not possible:

- **New agents** are unaffected — the next launch goes to a healthy account automatically.
- **A running agent cannot be switched.** Its account is fixed when the process starts, and the conversation lives inside that account's store. Anything claiming to hot-swap an account mid-turn is either restarting the process or lying.
- **Recovery is a move, not a switch:** park the exhausted account, copy the conversation to a healthy one, resume there.

```sh
agent-link rescue              # which conversations died on a limit, and where
agent-link rescue 6 --go       # park those accounts and move the chats to a healthy one
```

`--go` prints the exact resume command for each. Or do one by hand:

```sh
agent-link handoff claude <session-id> you@other.com
agent-link run claude you@other.com claude --resume <session-id>
```

Resuming re-sends the conversation, so the new account pays for that context. On a long session, `/compact` before handing it over keeps the bill down.

### Where is the work actually going?

```sh
agent-link insights            # last 7 days, per account
```

```
  you@work.com      primary  █▄▄▄▅▁▁  187 sessions · 47.2M out · 96% cached · 99% of work
                             37 launches · fable-5, opus-5 · mostly my-main-repo
                             ⚠ 112 limit refusals · probe this account before relying on it
  you@home.com      account  ·····▇█   10 sessions ·  692k out · 97% cached ·  1% of work
```

Read from your own transcripts, so it costs nothing: daily activity, sessions, output tokens, how much input came from cache, which models each account ran, its busiest project, and how often it was refused for a limit. A lopsided share means rotation is not reaching your other accounts — usually because they are parked, signed out, or were added recently.

### Which account am I on right now?

Run this inside any agent or shell — one line, nothing else:

```sh
agent-link whoami
# claude: you@home.com (account, 12 launches) · next: you@work.com
```

It reads the config dir the current process was launched with, so an agent asking mid-conversation gets its *own* account, not the default. `agent-link next claude` prints just the account rotation would choose next, and neither command disturbs the rotation order.

## Use with an editor or orchestrator

Anything that lets you set **a command** or **environment variables** can use agent-link:

| Your tool lets you set | Point it at |
| --- | --- |
| a command | `~/.agent-link/bin/claude-auto` (rotates) or `claude-1`, `claude-2` (pinned) |
| env vars | `CLAUDE_CONFIG_DIR=~/.agent-link/accounts/claude/<email>` |
| neither | wrap the call: `agent-link claude …` |

### Paseo

```jsonc
// ~/.paseo/config.json → agents.providers
"claude-auto": {
  "extends": "claude",
  "label": "Claude (Dynamic Agent Link)",
  "command": ["/home/you/.agent-link/bin/claude-auto"]
}
```

`agent-link auto` prints this snippet filled in for your machine. Provider changes apply with `paseo reload`.

> **Prefer a UI?** [paseo-agent-superpowers](https://github.com/itsjustanks/paseo-agent-superpowers) is a Paseo plugin that shows every account with health and usage, wires the router in one click, and manages MCP servers across all of them. agent-link is the CLI underneath; each works without the other.

## Commands

```
agent-link                       interactive dashboard
agent-link status                every account and its state
agent-link whoami [prov]         one line: the account this process is using, and what is next
agent-link next [prov]           just the account rotation would pick next
agent-link add <prov> <email>    create an account and sign in
agent-link login [prov] [email|all]      sign in whatever needs it
agent-link claude|codex [args]   run that CLI on the next account in rotation
agent-link auto                  write the auto-routing launchers
agent-link cooldown <prov> <email> [min|clear]   park / unpark an account
agent-link handoff <prov> <session-id> <email>   move a chat to another account
agent-link run <prov> <email> [cmd...]   run anything under one account
agent-link use <prov> <email|N|primary>  point plain claude/codex at an account
agent-link route enable|disable|status   manage the plain-command shims
agent-link shims                 numbered per-account shims (claude-1, …)
agent-link env <prov> <email>    eval-able export for one account
agent-link sync                  copy MCP servers + project trust into accounts
agent-link remove <prov> <email> delete an account slot and its login
agent-link doctor                sanity checks
```

## Things worth knowing

- **Adding an account can sign another one out.** Claude keeps every config-dir login in one shared keychain item, and a new login can evict an existing entry. Run `agent-link status` after adding an account and re-login anything that dropped. Keeping your primary in rotation (instead of duplicating it as an account slot) means one fewer entry to hold.
- **Never move or rename the accounts directory.** Claude binds each login to the literal config-dir path, so moving it silently signs out every Claude account. (Codex survives — its credentials are files inside the folder.) This is also why routing uses a launcher and not a symlink.
- **Sign-in needs a terminal.** Both CLIs finish by asking you to paste a code back, so the browser step cannot be automated from a background process.
- **Rate limits belong to accounts.** Two entries signed into the same account are one pool, not two.

## How it works

An account is just the CLI's own config directory, relocated: Claude Code reads `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`. The CLIs manage their own credentials inside it — **agent-link never reads, writes, copies or backs up a token**. Your original `~/.claude` and `~/.codex` stay untouched and remain the "primary".

Routing is a small launcher script that picks an account and `exec`s the real CLI, so the child process is the genuine article with nothing wrapped around it. Selection state (last used, launch count, cooldowns) lives in `~/.agent-link/state`.

`agent-link sync` copies MCP server definitions, project-trust flags, `settings.json` preferences (output style, permissions, env) and any custom output styles from your primary into each account — preferences and definitions only, never credentials. Run it after changing a setting you want everywhere, and after adding an account. OAuth-based MCP servers authorize once per account, since those grants belong to the account.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| An account shows "not logged in" but you signed in | A later login evicted it — sign in again (see above) |
| *"No conversation found with session ID"* | A resume reached the wrong account; update agent-link, which pins resumes |
| Rotation always picks the same account | The others are parked, out of credit, or signed out — `agent-link status` says which |
| `claude` not found by a shim | Alias-only install; run `claude install` to get a real binary on PATH |

## License

MIT
