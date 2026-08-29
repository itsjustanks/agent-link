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

**A usage limit kills your afternoon.** As an account climbs toward its limit, agent-link drains new work off it; account-wide limits park the account while named-model limits exclude only that account/model pair; and a conversation that died mid-task continues on an eligible account with a plain `--resume` — or resumes itself, if it was a [Paseo](https://paseo.sh) agent. Claude reports through its statusline and hooks, Codex through its own rollout files. You stop noticing limits.

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

Keep the provider CLIs current automatically:

```sh
agent-link toolchain enable   # daily at 04:15, plus one safe run now
agent-link toolchain status   # installed versions and the last update result
```

The updater handles Claude Code, Codex, Kimi Code and Grok. It checks both
Paseo and the process table before each update; a live provider, or an
unreadable runtime state, is skipped until the next day. It never kills or
restarts an agent and never changes credentials. Paseo itself remains managed
by the desktop app. Unknown providers are left untouched rather than invoking
an unverified update command. macOS launchd is preferred; if registration is
unavailable, AgentLink installs the same daily job through cron instead. On a
Paseo host where both registration paths are restricted, the already-loaded
Paseo watchdog triggers the low-priority daily run.

---

## In Paseo

`agent-link app install paseo` adds two tabs to [Paseo](https://paseo.sh).

### 🔗 Agent Link

![The Agent Link tab: a Routing card showing the auto-router installed for Claude and Codex, then each account with its state, park timer, credit note and launch count](docs/screenshots/agent-link.png)

The panel opens on **AgentRouter**, followed by **Accounts, Limit sentry, Memory guard, and FAQs**. Provider tabs — Claude, Codex, Kimi, Grok, and custom additions — appear only inside Accounts. Automatic routing is the first collapsible account-list row; every account row owns its live quota meters, reset times, rotation state, cooldown, priority, and on-request 7-day activity. There are no separate usage or routing dashboards repeating the same accounts. A cheap 30-second heartbeat refreshes provider registration, account readiness, routing decisions, limit sentry, and capacity snapshots without launching a provider; **Deep check** remains manual because it starts the provider. **Probe accounts** spends one small Claude turn per account, keeps refusals held out, and releases only accounts that actually serve.

One click installs a **Dynamic Agent Link** provider. Pick that single provider and every new agent passes through a deterministic route: quota/health gate → priority target group → least-recently-used account. The panel labels its **next new launch** forecast separately from the bounded history of real Paseo agents and projects. A running agent is never re-routed: its account is fixed when the process starts, and nothing swaps underneath a live session.

Every agent's **Routing** panel shows its server-derived provider, model, AgentLink account, route decision, and agent ID. AgentRouter keeps control and answer models separate. A hidden runtime says `Unknown (runtime not exposed)` instead of guessing. The composer-pill implementation ships in source, but this compatibility build does not register it because Paseo 0.7.0-beta.1 removes its client import without removing `addClientSide`, which prevents the whole plugin from loading.

The **AgentRouter** tab explains and configures the optional virtual Paseo route. Fable 5 is the default prompt interpreter; the UI can switch its Claude account source and model, edit every ordered group, and add any native, custom, or ACP provider/model target. Every request is delegated to a concrete Paseo child. Direct Paseo profiles remain faster when you already know the model. Claude and Codex targets still pass through Dynamic Agent Link, so account health and cooldown are preserved.

The **Accounts** tab also manages provider CLI updates. Claude, Codex, Kimi, and Grok have verified recipes; every other Paseo catalog or custom provider appears and can receive an argument-by-argument updater. Scheduled runs prove the provider is idle before changing its binary. This is separate from **Probe accounts**: a probe spends a tiny model turn to verify quota, while an update check only compares software releases.

AgentRouter uses virtual aliases, healthy targets, ordered groups, cooldowns, failover, and decision evidence. It delegates to explicit Paseo child agents, while Agent Link separately routes CLI account launches. It never claims to switch an in-flight agent. Routed launches record the exact Paseo agent ID and working directory, so duplicate-account rows show which agent last consumed that shared quota. If every target is parked, the launch stops cleanly instead of silently falling onto a known-exhausted primary. Paseo binds a custom provider to one adapter, so the controller must boot through a Claude-compatible adapter; once running, its target groups can use any native, custom, or ACP provider.

### 🔌 MCP

![The MCP tab: servers listed with coverage and live health, plus actions to add, import and sync definitions](docs/screenshots/mcp.png)

Each server now owns its automatic health result and destination/account rows in one full-width view. There is no separate OAuth destination list: a destination owns both its definition and, only when the provider reports it, its account OAuth action. Header/env values, credential-bearing URL queries and secret command arguments are classified as inline credentials instead of being mislabeled OAuth.

- Add, remove or **rename a server everywhere at once**
- **Edit the raw JSON** for one destination, with a dry-run preview before anything is written (TOML destinations are translated both ways, so you never type TOML and never need to know that Codex spells headers `http_headers`)
- **Paste a definition straight out of a README** to import it — fenced code, comments and trailing commas are cleaned up and reported, and unfilled placeholders block the write
- **Run or reconnect OAuth per account** from the panel. The daemon opens its computer's default browser; the authorization URL, callback target and a callback-return field remain available if automatic return fails.
- **Open MCP connections on any Paseo workspace** to read that workspace's `.mcp.json`, see its project servers and authorize each account from the same side panel
- Automatic health checks, gap detection, and per-account authorisation status

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
#       HELD for claude-fable-5 — other Claude models remain routable
```

Each account answers one token on that model; `--park` holds model refusals and revoked logins out of rotation. A transport or process error is reported but never treated as quota evidence. Re-run after a reset or sign-in; only a passing call releases the hold.

Two guarantees that make this safe:

- **A running process is never re-routed.** Routing happens at launch; nothing switches under a live session.
- **Resumes follow their conversation.** A conversation only exists inside the account that created it, so `--resume <id>` runs on whichever account holds that session — including your **primary**, which owns every conversation started before you added accounts. (Without this you get *"No conversation found with session ID"*.) And when that account is parked or just got refused for a limit, the launcher **moves the conversation to a healthy account first** and resumes there.

Paseo's Codex provider runs `codex app-server`, so the thread ID arrives over RPC after process launch instead of appearing in command-line arguments. The generated `codex-auto` launcher resolves `PASEO_AGENT_ID` back to Paseo's persisted agent record before choosing an account; old chats therefore follow their rollout even when the owning account is parked.

### When an account hits its limit mid-conversation

Be clear about what is and is not possible:

- **New agents** are unaffected — the next launch goes to a healthy account automatically.
- **A running agent cannot be switched.** Its account is fixed when the process starts, and the conversation lives inside that account's store. Anything claiming to hot-swap an account mid-turn is either restarting the process or lying.
- **Recovery is a move, not a switch** — and through the auto launcher it is automatic: resume the chat (`claude --resume <id>`, or restart the agent in your editor) and the launcher parks the refused account, copies the conversation to the healthiest other one, and continues there. `agent-link resume-target claude <session-id>` shows where a resume would land without moving anything; `--go` (what the launchers pass) performs the move.
- **Paseo recovery does not need repeated “continue” messages.** The refusal hook records the exact account/model and queues one continuation for the host watchdog. The watchdog also scans recent stopped agents from every provider once a minute, so Codex and providers without hooks are still visible. It retires only the provider process pinned to a proven AgentLink route, then Paseo relaunches that transcript through the next eligible account. If no healthy alternate exists, the request waits instead of hammering the exhausted account. Direct, Kimi, Grok and other single-account agents are reported as blocked for an explicit retry or AgentRouter handoff—there is no dishonest cross-provider “resume” that loses their transcript. `agent-link recover --scan` runs the same pass manually.

### Before the wall: let Claude Code itself report its quota

```sh
agent-link hooks install             # account slots
agent-link hooks install --primary   # include your primary login too (opt-in)
```

This wires the two signals Claude Code actually emits, per account:

- **The statusline JSON** (Pro/Max) carries live 5-hour and weekly `used_percentage` plus the reset time. A tiny wrapper tees it on every render: at **85%** the account is flagged *nearing* — new launches drain to other accounts while anything already running (and resumes of its own conversations) rides on; at **99%** it is parked until Claude's own reported reset. Your existing statusline keeps rendering unchanged (and if you had none, you get one showing the percentages).
- **A `StopFailure` hook** on `rate_limit`/`billing_error` parks the account the instant a turn actually dies on a limit — no waiting for the next launch to notice.

Claude exposes those quota fields only to an **interactive** statusline after its first response. Paseo runs Claude non-interactively, so Agent Link also reads Claude's token-free cached `/usage` result from `.claude.json` when available. If a routed Claude account still says “no report,” run `agent-link run claude <email> claude`, send one message, and refresh. Codex does not need this step because every rollout persists its quota windows.

So the full lifecycle is hands-off: drain at 85% → park at 99% or on the refusal → dead chats continue on the next `--resume` → a *window* park expires at the provider's exact reset. A refusal with no verified reset becomes a **HOLD**, not a guessed timer; a small hourly recheck or an explicit `agent-link probe` releases it only after it serves. `agent-link cooldown <prov> <email> clear` remains the manual override.

`agent-link usage` is `/usage` across every account: live 5-hour/weekly percentages with reset times, captured from each account's own sessions, plus park/hold state — the same meters render per account in the Paseo panel. And `agent-link prefer <prov> <email> first|last` biases routing toward or away from an account (health still wins: a preferred account that is parked or nearing loses to a healthy ordinary one). `agent-link pools` shows the *nearing limit* tier; `agent-link hooks remove` undoes everything.

**Codex gets the same lifecycle with no hooks at all**: every Codex turn writes `used_percent`, the reset time, and a limit-reached flag into its own rollout file, and the router reads the newest one at routing time — 85% flags nearing, 99% or the flag parks until Codex's own reset. `codex resume <id>` and `codex resume --last` route through the same owner-or-healthiest logic as Claude resumes, and `claude -c` / `--continue` finds the newest chat for the current project across every account. Moved transcripts are offset-marked so a dead account's telemetry can never park the healthy account it was moved to.

**Running routed agents in [Paseo](https://paseo.dev) resume themselves.** Claude's refusal hook durably hands recovery to the host watchdog, and the watchdog's provider-neutral scan covers Codex, AgentRouter, Kimi, Grok and custom providers before the panel has ever opened. Automatic transcript-preserving recovery requires a recorded AgentLink route; other providers are surfaced and held for manual retry/handoff rather than repeatedly sent to the same exhausted account. The panel's *limit sentry* is a second path while open. A model-only Claude refusal excludes only that account/model pair. And when [Paseo's built-in MCP tools](https://paseo.sh/docs/mcp) are injected into agents (`daemon.mcp.injectIntoAgents`), the synced output style teaches orchestrator agents to revive their own dead subagents with `send_agent_prompt`.

**Heavy type-checks cool down instead of taking the Mac with them.** The Paseo panel's memory guard treats each shell/package-runner/compiler chain as one job and permits one job at a time across Paseo agents. If macOS reports 15% memory available or less, a job already using at least 512 MB has its real compiler temporarily suspended with `SIGSTOP`; it continues with `SIGCONT` at 25%. Nothing is killed, provider sessions keep their account, and type-checks started outside Paseo are out of scope. The Agent Link tab shows the live state and has an off switch. Thresholds can be overridden with `AGENT_LINK_TYPECHECK_CONCURRENCY`, `AGENT_LINK_MEMORY_PAUSE_PERCENT`, `AGENT_LINK_MEMORY_RESUME_PERCENT`, and `AGENT_LINK_RESOURCE_POLL_SECONDS`.

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
agent-link login [prov] [email|all]      sign in primary/slots that need it
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
agent-link style install         apply the concise response contract to primary + managed accounts
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

An account is just the CLI's own config directory, relocated: Claude Code reads `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`. The CLIs manage their own credentials inside it — **agent-link never reads, writes, copies or backs up a token**. Your original `~/.claude` and `~/.codex` remain the "primary"; only the explicit `agent-link style install` command changes their response-style files, with recoverable backups.

Routing is a small launcher script that picks an account and `exec`s the real CLI, so the child process is the genuine article with nothing wrapped around it. Selection state (last used, launch count, cooldowns) lives in `~/.agent-link/state`.

`agent-link sync` copies MCP server definitions, project-trust flags, `settings.json` preferences (output style, permissions, env) and any custom output styles from your primary into each account — preferences and definitions only, never credentials. Run it after changing a setting you want everywhere, and after adding an account. OAuth-based MCP servers authorize once per account, since those grants belong to the account.

`agent-link style install` applies one compact response contract to Claude output styles and Codex `AGENTS.md` across the primary and managed accounts. Task updates use only the relevant **Asked / Working on / Decision / Outcome / Goal** bullets; simple answers stay one short paragraph. Paseo's daemon system prompt covers other providers launched through Paseo.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| An account shows "not logged in" but you signed in | A later login evicted it — sign in again (see above) |
| *"No conversation found with session ID"* | A resume reached the wrong account; update agent-link, which pins resumes |
| Rotation always picks the same account | The others are parked, out of credit, or signed out — `agent-link status` says which |
| `claude` not found by a shim | Alias-only install; run `claude install` to get a real binary on PATH |

## License

MIT
