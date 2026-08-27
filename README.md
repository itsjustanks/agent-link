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

## Three problems this solves

**You can only use one account at a time.** If you have more than one Claude or Codex account, you hit a usage limit on one while the others sit idle. Account-switcher tools swap credentials in and out, which logs running sessions out mid-task. agent-link instead gives each account its own config directory — `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex — so every account is live at the same time. **N accounts, N rate limits.** It never reads, copies or backs up a token, so nothing decays and no running agent is ever signed out.

**A usage limit kills your afternoon.** As an account climbs toward its limit, agent-link drains new work off it; when it hits the wall it is parked until the provider's own reset time; and a conversation that died mid-task continues on a healthy account with a plain `--resume` — or resumes itself, if it was a [Paseo](https://paseo.sh) agent. Claude reports through its statusline and hooks, Codex through its own rollout files. You stop noticing limits.

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

**Updating** is one command — it installs the [latest release](https://github.com/itsjustanks/agent-link/releases) (CLI and app sources from the same tag) and reinstalls the apps you have, so the CLI and its UI never drift apart:

```sh
agent-link update
```

---

## In Paseo

`agent-link app install paseo` adds two tabs to [Paseo](https://paseo.sh).

### 🔗 Agent Link

![The Agent Link tab: a Routing card showing the auto-router installed for Claude and Codex, then each account with its state, park timer, credit note and launch count](docs/screenshots/agent-link.png)

Every enabled provider gets a dynamic tab — including Kimi, Grok, and custom additions — while Claude/Codex account aliases roll into their family tab. A cheap 30-second heartbeat refreshes provider registration, account readiness, routing decisions, limit sentry, and capacity snapshots without launching a provider; **Deep check** is deliberately manual because it starts the provider. The **Provider usage** dashboard's **Limits** view names each rolling session/weekly window, shows used and available capacity, exact reset countdowns and the viewing device's local reset time, telemetry freshness, plan/model context, credits, and routing pressure. **Activity · 7 days** shows sessions, input/output/reasoning tokens, cache rate, context window, projects, and models used. Credit state and **park/resume** remain beside the account that needs them.

One click installs a **Dynamic Agent Link** provider. Pick that single provider and every new agent passes through a deterministic route: quota/health gate → priority target group → least-recently-used account. The panel shows every target, its quota headroom and cooldown state, the next decision, and a bounded history of real launches. A running agent is never re-routed: its account is fixed when the process starts, and nothing swaps underneath a live session.

The control-plane vocabulary is inspired by [Plexus](https://github.com/mcowger/plexus) (MIT): healthy targets, ordered groups, selectors, cooldowns, and decision evidence. Agent Link applies those ideas to CLI process launches rather than API requests, so failover means the next launch/resume moves to a healthy account; it never claims to switch an in-flight agent. Automatic resume moves and manual handoffs are written into the same bounded route history with a short session ID, source, and destination, so account cycling is visible. If every target is parked, the launch stops cleanly instead of silently falling onto a known-exhausted primary.

### 🔌 MCP

![The MCP tab: 29 servers listed with a coverage bar each, filters for All, Gaps and Issues, and buttons to add a server, paste JSON, sync accounts and run a health check](docs/screenshots/mcp.png)

One table for every MCP server across every account and every CLI on the machine — Claude Code, Codex, Kimi, Grok, and each per-account slot.

- Add, remove or **rename a server everywhere at once**
- **Edit the raw JSON** for one destination, with a dry-run preview before anything is written (TOML destinations are translated both ways, so you never type TOML and never need to know that Codex spells headers `http_headers`)
- **Paste a definition straight out of a README** to import it — fenced code, comments and trailing commas are cleaned up and reported, and unfilled placeholders block the write
- **Run the OAuth sign-in per account** from the panel, instead of hunting for the right terminal command
- Health checks, gap detection, and per-account authorisation status

Every write is atomic, keeps the file's permissions, backs it up first, and refuses to overwrite a config it cannot parse.

Looking for the Canvas tab — the one that renders and shares what your agents build? It grew into its own plugin: [**paseo-canvas**](https://github.com/itsjustanks/paseo-canvas). Install either, or both; they are independent.

### Don't want the CLI?

You do not need it. Installed from the Paseo UI, the plugin reads your account directories itself and syncs MCP definitions itself — accounts and MCP are fully usable with no terminal.

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

---

## The three ways to use it

| You want | Use | Behaviour |
| --- | --- | --- |
| Spread work across all accounts | `agent-link claude` · or point a provider at `~/.agent-link/bin/claude-auto` | Health gate, then priority group, then least-recently-used account |
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
- **Resumes follow their conversation.** A conversation only exists inside the account that created it, so `--resume <id>` runs on whichever account holds that session — including your **primary**, which owns every conversation started before you added accounts. (Without this you get *"No conversation found with session ID"*.) And when that account is parked or just got refused for a limit, the launcher **moves the conversation to a healthy account first** and resumes there.

### When an account hits its limit mid-conversation

Be clear about what is and is not possible:

- **New agents** are unaffected — the next launch goes to a healthy account automatically.
- **A running agent cannot be switched.** Its account is fixed when the process starts, and the conversation lives inside that account's store. Anything claiming to hot-swap an account mid-turn is either restarting the process or lying.
- **Recovery is a move, not a switch** — and through the auto launcher it is automatic: resume the chat (`claude --resume <id>`, or restart the agent in your editor) and the launcher parks the refused account, copies the conversation to the healthiest other one, and continues there. `agent-link resume-target claude <session-id>` shows where a resume would land without moving anything; `--go` (what the launchers pass) performs the move.

### Before the wall: let Claude Code itself report its quota

```sh
agent-link hooks install             # account slots
agent-link hooks install --primary   # include your primary login too (opt-in)
```

This wires the two signals Claude Code actually emits, per account:

- **The statusline JSON** (Pro/Max) carries live 5-hour and weekly `used_percentage` plus the reset time. A tiny wrapper tees it on every render: at **85%** the account is flagged *nearing* — new launches drain to other accounts while anything already running (and resumes of its own conversations) rides on; at **99%** it is parked until Claude's own reported reset. Your existing statusline keeps rendering unchanged (and if you had none, you get one showing the percentages).
- **A `StopFailure` hook** on `rate_limit`/`billing_error` parks the account the instant a turn actually dies on a limit — no waiting for the next launch to notice.

Claude exposes those quota fields only to an **interactive** statusline after its first response. Paseo runs Claude non-interactively, so Agent Link also reads Claude's token-free cached `/usage` result from `.claude.json` when available. If a routed Claude account still says “no report,” run `agent-link run claude <email> claude`, send one message, and refresh. Codex does not need this step because every rollout persists its quota windows.

So the full lifecycle is hands-off: drain at 85% → park at 99% or on the refusal → dead chats continue on the next `--resume` → a *window* park expires at the real reset, while a **monthly spend limit becomes a HOLD** — no expiry, because time cannot prove it over; a passing `agent-link probe` or `agent-link cooldown <prov> <email> clear` releases it (and `cooldown <prov> <email> hold` parks by hand the same way).

`agent-link usage` is `/usage` across every account: live 5-hour/weekly percentages with reset times, captured from each account's own sessions, plus park/hold state — the same meters render per account in the Paseo panel. And `agent-link prefer <prov> <email> first|last` biases routing toward or away from an account (health still wins: a preferred account that is parked or nearing loses to a healthy ordinary one). `agent-link pools` shows the *nearing limit* tier; `agent-link hooks remove` undoes everything.

**Codex gets the same lifecycle with no hooks at all**: every Codex turn writes `used_percent`, the reset time, and a limit-reached flag into its own rollout file, and the router reads the newest one at routing time — 85% flags nearing, 99% or the flag parks until Codex's own reset. `codex resume <id>` and `codex resume --last` route through the same owner-or-healthiest logic as Claude resumes, and `claude -c` / `--continue` finds the newest chat for the current project across every account. Moved transcripts are offset-marked so a dead account's telemetry can never park the healthy account it was moved to.

**Running agents in [Paseo](https://paseo.dev) resume themselves.** The panel's *limit sentry* watches the daemon's agent stream: when an agent errors out and its timeline shows a genuine limit/billing failure (not a conversation about limits), it appears in the Agent Link tab with a one-click **Resume** — and with **Auto** switched on, the sentry nudges the agent immediately. Either way the relaunch goes through the account router, so the conversation continues on a healthy account with nobody watching. And when [Paseo's built-in MCP tools](https://paseo.sh/docs/mcp) are injected into agents (`daemon.mcp.injectIntoAgents`), the synced output style teaches orchestrator agents to revive their own dead subagents with `send_agent_prompt` — recovery that works even before the panel has ever been opened.

**Heavy type-checks cool down instead of taking the Mac with them.** The Paseo panel's memory guard permits one TypeScript check at a time across Paseo agents. If macOS reports 15% memory available or less, a check already using at least 512 MB is temporarily suspended with `SIGSTOP`; it continues with `SIGCONT` at 25%. Nothing is killed, provider sessions keep their account, and type-checks started outside Paseo are out of scope. The Agent Link tab shows the live state and has an off switch. Thresholds can be overridden with `AGENT_LINK_TYPECHECK_CONCURRENCY`, `AGENT_LINK_MEMORY_PAUSE_PERCENT`, `AGENT_LINK_MEMORY_RESUME_PERCENT`, and `AGENT_LINK_RESOURCE_POLL_SECONDS`.

To sweep up in bulk, or move a chat somewhere specific by hand:

```sh
agent-link rescue              # which conversations died on a limit, and where
agent-link rescue 6 --go       # park those accounts and move the chats to a healthy one
agent-link handoff claude <session-id> you@other.com   # "primary" works too
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
#  ● paseo      Accounts and MCP across your coding CLIs, in Paseo  installed
#  ○ vscode     Rotating accounts in VS Code or Cursor         available

agent-link app install paseo            # install (re-run to upgrade)
agent-link app install paseo --link     # register a checkout in place, for development
agent-link app remove paseo             # uninstall; the source is left alone
```

| App | What it gives you |
| --- | --- |
| [`paseo`](apps/paseo) | The two tabs described [above](#in-paseo) — full detail in [`apps/paseo/README.md`](apps/paseo/README.md) |
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
agent-link remove <prov> <email> archive an account slot outside routing
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
