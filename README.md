<div align="center">

# agent-link

**Run several Claude Code and Codex accounts from one machine — and see what your agents actually build.**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Linux-informational)
![Dependencies](https://img.shields.io/badge/deps-bash%20%2B%20python3-lightgrey)
![Paseo](https://img.shields.io/badge/Paseo-plugin%20included-8A63D2)

</div>

```
  CLAUDE                              plain `claude` → primary
    ● you@work.com                   primary        in rotation · 12 launches
    ● you@home.com                   logged in      in rotation · 9 launches · last 4m ago
    ● you@side.com                   logged in      spend limit reached — routing skips it
    dynamic routing: ready (~/.agent-link/bin/claude-auto)
```

## Two problems this solves

**You can only use one account at a time.** If you have more than one Claude or Codex account, you hit a usage limit on one while the others sit idle. Account-switcher tools swap credentials in and out, which logs running sessions out mid-task. agent-link instead gives each account its own config directory — `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex — so every account is live at the same time. **N accounts, N rate limits.** It never reads, copies or backs up a token, so nothing decays and no running agent is ever signed out.

**Your agents write things you never see.** Dashboards, reports and diagrams land in a worktree you would have to go and find in a terminal. agent-link finds them and renders them — live, inside your editor.

It is one bash file with no dependencies beyond `python3`, plus an optional [Paseo](https://paseo.sh) plugin that puts all of it in a UI.

---

## Install

```sh
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/itsjustanks/agent-link/main/agent-link -o ~/.local/bin/agent-link
chmod +x ~/.local/bin/agent-link
```

Make sure `~/.local/bin` is on your `PATH`. Delete the file to uninstall.

You need whichever CLIs you want to manage — [Claude Code](https://claude.com/claude-code) (`npm i -g @anthropic-ai/claude-code`) and/or [Codex](https://github.com/openai/codex) (`npm i -g @openai/codex`). You do not need to be logged into them first.

```sh
agent-link                              # interactive dashboard
agent-link add claude you@work.com      # create an account and sign in
agent-link add claude you@home.com
agent-link auto                         # enable automatic routing
agent-link claude                       # Claude Code on the next account in rotation
```

`agent-link status` shows every account: signed in, in rotation, parked, out of credit, or the wrong account signed into a slot.

**Updating** is one command — it replaces the CLI, refreshes the app sources, and reinstalls the apps you have, so the CLI and its UI never drift apart:

```sh
agent-link update
```

---

## In Paseo

`agent-link app install paseo` adds three tabs to [Paseo](https://paseo.sh).

### 🔗 Agent Link

![The Agent Link tab: a Routing card showing the auto-router installed for Claude and Codex, then each account with its state, park timer, credit note and launch count](docs/screenshots/agent-link.png)

Every Claude and Codex account on the machine, with live health, **7-day usage** read from your own transcripts (sessions, tokens, cache rate, which models each account actually ran), credit state, and **park/resume** for an account that has hit a limit.

One click installs a **Dynamic Agent Link** provider. Pick that single provider and every new agent is routed to the least-recently-used healthy account automatically — no command, no choosing. A running agent is never re-routed: its account is fixed when the process starts, and nothing swaps underneath a live session.

### 🔌 MCP

![The MCP tab: 29 servers listed with a coverage bar each, filters for All, Gaps and Issues, and buttons to add a server, paste JSON, sync accounts and run a health check](docs/screenshots/mcp.png)

One table for every MCP server across every account and every CLI on the machine — Claude Code, Codex, Kimi, Grok, and each per-account slot.

- Add, remove or **rename a server everywhere at once**
- **Edit the raw JSON** for one destination, with a dry-run preview before anything is written (TOML destinations are translated both ways, so you never type TOML and never need to know that Codex spells headers `http_headers`)
- **Paste a definition straight out of a README** to import it — fenced code, comments and trailing commas are cleaned up and reported, and unfilled placeholders block the write
- **Run the OAuth sign-in per account** from the panel, instead of hunting for the right terminal command
- Health checks, gap detection, and per-account authorisation status

Every write is atomic, keeps the file's permissions, backs it up first, and refuses to overwrite a config it cannot parse.

### 🖼 Canvas

![The Canvas tab: a list of artifacts beside a live rendered Markdown report, with a Live and Image toggle](docs/screenshots/canvas.png)

The HTML, Markdown, SVG and images your agents write, found automatically across your workspaces — and **rendered live inside Paseo**. Live means live: the real interactive page, which reloads itself when the agent rewrites the file.

- **Get a link** — one press publishes a public URL anyone can open, served from disk so it always shows the current file
- **Send to chat** — post the render into the agent's conversation as an image, so the agent can see what it built
- **New canvas** — describe a dashboard and an agent builds it
- Finds artifacts in workspace roots, `artifacts/`, `reports/`, `dashboards/`, your own `~/Artifacts` and `~/Diagrams`, and Claude Code's session scratchpads

On iOS and Android the page is rasterised on the daemon and shown as an image instead — which is also what happens when your Paseo daemon is a remote server rather than your laptop.

### Don't want the CLI?

You do not need it. Installed from the Paseo UI, the plugin reads your account directories itself, syncs MCP definitions itself, and renders canvases itself — accounts, MCP and Canvas are all fully usable with no terminal.

The one exception is **routing**, because a Paseo provider runs a *command*, and that command is a small launcher script the CLI writes. So the Agent Link tab offers to install the CLI for you: one press downloads a single file to `~/.local/bin`, writes the launchers, and routing becomes available — and the exact `curl` command is shown next to the button for anyone who would rather run it themselves.

### Installing the plugin

**From the CLI** — one command, which copies the plugin into Paseo's own plugins directory, installs and typechecks it, registers the ID and confirms the daemon is running it:

```sh
agent-link app install paseo
```

**From the Paseo UI** — clone this repo, then:

1. **Settings → Plugins**
2. Turn on **Enable plugins**
3. Paste `<clone>/apps/paseo` into **Plugin directory**
4. Leave **Plugin installation ID** blank (the manifest supplies `agent-link`)
5. Press **Install directory**

No `npm install` is needed — the plugin imports only modules Paseo already provides. Requires Paseo ≥ 0.5 (tested on 0.5.0-beta.5).

Two optional extras, each of which the panel will name for you if it is missing: **Chrome or Chromium** to rasterise a page for the image view, and **cloudflared** for public links. Everything else works without them.

---

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

### Paseo, by hand

The plugin does this for you, but if you would rather wire it yourself:

```jsonc
// ~/.paseo/config.json → agents.providers
"claude-auto": {
  "extends": "claude",
  "label": "Claude (Dynamic Agent Link)",
  "command": ["/home/you/.agent-link/bin/claude-auto"]
}
```

`agent-link auto` prints this snippet filled in for your machine. Provider changes apply with `paseo reload` — no daemon restart, so nothing mid-task is disturbed.

## Integrations

Optional add-ons live in [`apps/`](apps), one folder per tool. They are never required — the CLI works alone — and each only shows as installable when that tool is actually on your machine.

```sh
agent-link app list
#  ● paseo      Accounts, MCP and shareable canvases in Paseo  installed
#  ○ vscode     Rotating accounts in VS Code or Cursor         available

agent-link app install paseo            # install (re-run to upgrade)
agent-link app install paseo --link     # register a checkout in place, for development
agent-link app remove paseo             # uninstall; the source is left alone
```

| App | What it gives you |
| --- | --- |
| [`paseo`](apps/paseo) | The three tabs described [above](#in-paseo) — full detail in [`apps/paseo/README.md`](apps/paseo/README.md) |
| [`vscode`](apps/vscode) | How to point VS Code or Cursor at a rotating or pinned account |

Anything missing — Paseo itself, Node, the plugins switch in Settings — is named rather than guessed at. Adding another editor or tool means dropping a folder in `apps/` with an `app.json`.

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
agent-link app [list|install|remove] [id] [--link]   optional integrations under apps/
agent-link update                update the CLI, then reinstall the apps you have installed
agent-link fix [model]           test accounts, rescue stuck chats, resync — one-shot cleanup
agent-link insights [days]       where work went: sessions, tokens, cache rate, models, refusals
agent-link probe [prov] [model] [--park]   ask each account to answer on a model
agent-link rescue [hours] [--go] conversations that hit a limit; --go moves them
agent-link whoami / next         which account this process uses / what is next
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
