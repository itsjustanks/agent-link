# paseo-agent-superpowers

**A [Paseo](https://paseo.sh) plugin for people running more than one AI coding account: see every account and provider connector with live health, wire each account in as its own parallel provider, and manage MCP servers across all of them from one table.**

Two sidebar tabs:

## 👥 Agent Link

One card per provider connector — **Claude Code, Codex, Kimi Code, Grok** — each with a health dot and Paseo's own diagnostic one click away. Inside each card, a table of every account under it:

- the **primary** account (the login your plain `claude` / `codex` uses), shown by email
- every **account slot** with live state: 🟢 logged in · 🟠 login needed · 🔴 wrong account (the slot folder says one email, the login inside is another)
- a **pool summary** — "5 logged-in entries → 4 independent quota pools" — and a ⚠ badge on any two entries signed into the *same* account, since a rate limit belongs to an account, not to a slot
- **7-day usage** — on request, reads each account's own transcripts and reports sessions, input/output tokens and which models that account actually ran. No costs and no quota percentages: neither CLI exposes remaining quota without the account's token, which this plugin never reads.
- **Credit state** — when an account has hit a spend limit, its row says so (Claude records the reason in its own config), instead of you finding out when an agent dies.
- **Rotation usage** — a bar and a count showing how many agents the router has handed each account and when it was last used, so you can see the rotation actually spreading. (This is launches routed by agent-link, not Anthropic/OpenAI quota: neither CLI exposes remaining quota per account without reading its token, which this plugin deliberately does not do. Paseo's own usage figure covers the primary accounts only.)
- **+ Add account** — creates the slot for a new account and hands you the one command to finish sign-in. The browser step itself stays in a terminal because both CLIs ask you to paste a code back; the row turns green once you have (and flags a mismatch if you signed in as someone else)
- **Auto-router** — one click wires a single `Claude (Dynamic Agent Link)` / `Codex (Dynamic Agent Link)` provider that sends each new agent to the least-recently-used live account. Pick that one provider and your accounts get used automatically; a running agent is never re-routed.
- **Park 3h / Resume** — take an account that hit its limit out of rotation and put it back
- **Wire into Paseo** — one click adds that account as a Paseo custom provider (`extends` the native integration, pointing `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at the slot). Each wired account is an independent quota pool: five agents across three Claude accounts genuinely run on three separate rate limits. A banner reminds you Paseo loads new providers at the next daemon restart.

## 🔌 MCP

A universal manager for **user-level** MCP servers across every provider on the machine — Claude Code and Codex primaries (labeled with their actual account), every wired provider, every account slot, plus Kimi Code and Grok. One row per server, one column-equivalent per destination:

- **Sticky header** with search and **All / Gaps / Issues** tabs
- **Health check** — HTTP servers get a real request (a 401/403 is reported as **auth needed**, which is the honest answer to "does this need authorizing?"); stdio servers get a binary-on-PATH check. 🟢 / 🟠 / 🔴 per server.
- **Expand** a server for its destination table: present or missing per destination, add or remove there
- **Edit** — every destination's own definition, side by side. Different auth per account is expected and supported: change one account's header and save just that destination, or take one destination's version and **Use for ALL**.
- **Reveal secrets** — masked (`•••last4`) by default; one tap shows the stored values. Masked values are preserved on save, so editing one account can never copy its token into another. (Deliberate cross-account copies — **Add to all** and **Use for ALL** — do carry a definition's inline credentials, which is the point of those buttons.)
- **Rename everywhere** — rewrites a server's key across every config that has it (copy-then-delete, so a failure can never lose the definition)
- **Add server** — http or stdio, headers/env as `KEY=VALUE` lines, targeting all destinations or specific ones
- **Sync accounts** — pushes user-level definitions and project trust from each primary into its account slots

Every write backs up the target config first (last 5 kept). A config file that exists but cannot be parsed is never overwritten.

### Built for narrow screens

Paseo plugins run on phones as well as desktop, so the panel uses one spacing scale that tightens on narrow layouts, buttons with real touch targets, account rows that put the identity on its own line above the detail, and an MCP destination table that stacks instead of squeezing labels to nothing.

## Install

```sh
git clone https://github.com/itsjustanks/paseo-agent-superpowers
cd paseo-agent-superpowers
npm install
npm run typecheck
paseo plugin install "$(pwd)"
```

Requires Paseo ≥ 0.5 with plugins enabled (Settings → Plugins). Tested against 0.5.0-beta.2.

**Nothing else is required.** Every provider and account it finds is one you already have — the plugin installs no software and creates no accounts. Providers you don't use simply don't appear.

### Optional: the agent-link CLI

[**agent-link**](https://github.com/itsjustanks/agent-link) is the companion CLI that creates and logs in account slots (`agent-link add claude you@work.com`) and can hot-switch which account the plain `claude` / `codex` command uses. The plugin is fully standalone without it — it reads whatever slots exist and does its own MCP sync — but with agent-link installed, logins become one command and the panel points you at it. The panel also reads hand-rolled slot layouts in `~/.claude-accounts` / `~/.codex-accounts`.

### Authentication by account

MCP *definitions* sync between accounts; MCP *grants* do not — a server is authorized once per account, which is what "server X is not connected" actually means. The MCP tab lists every account with how many servers it defines and which still need signing in, plus the exact command:

```sh
CLAUDE_CONFIG_DIR="~/.agent-link/accounts/claude/you@work.com" claude mcp login <server>
```

Project-scoped servers (defined in a repo's `.mcp.json`) are listed too, since they also need authorizing per account even though this plugin never edits them.

### Scope: user-level, not project-level

The MCP tab manages **user-level** (global) servers — each provider's own config, available in all your projects. A repo's own project-level servers (`.mcp.json` in the repository) belong to that repo and are never read or written.

## About rate limits and failover

Paseo has no automatic provider failover: an agent that hits a usage limit stops with an error and keeps its workspace — it does not move itself to another account. Three things reduce the pain, and the tab exposes all of them:

- **7-day usage** — on request, reads each account's own transcripts and reports sessions, input/output tokens and which models that account actually ran. No costs and no quota percentages: neither CLI exposes remaining quota without the account's token, which this plugin never reads.
- **Credit state** — when an account has hit a spend limit, its row says so (Claude records the reason in its own config), instead of you finding out when an agent dies.
- **Rotation usage** — a bar and a count showing how many agents the router has handed each account and when it was last used, so you can see the rotation actually spreading. (This is launches routed by agent-link, not Anthropic/OpenAI quota: neither CLI exposes remaining quota per account without reading its token, which this plugin deliberately does not do. Paseo's own usage figure covers the primary accounts only.)
- **+ Add account** — creates the slot for a new account and hands you the one command to finish sign-in. The browser step itself stays in a terminal because both CLIs ask you to paste a code back; the row turns green once you have (and flags a mismatch if you signed in as someone else)
- **Auto-router** — one provider that picks a live account per launch, so agents spread across accounts without you choosing
- **Park / Resume** — take an exhausted account out of rotation; new agents skip it until it recovers
- **Pool count** — see how many *independent* limits you actually have, with duplicates flagged

A running agent still keeps the account it started on; nothing re-routes mid-task (that is what breaks sessions).

Paseo's built-in usage figure reads the primary accounts only (`~/.claude`, `~/.codex`); it does not see per-account slots. Per-pool usage percentages would require reading each account's access token, which this plugin deliberately does not do.

## What stays in the terminal

Per-server MCP authorization, and finishing an account sign-in in the browser. The panel can *start* an account login for you (**+ Add account**), but the sign-in itself happens in the browser, and MCP OAuth Those flows are owned by each CLI and are **provider-specific and per-account**: Claude Code authorizes an MCP server with `/mcp` inside a session on that account; other CLIs have their own flow. No panel can do them for you. What this panel does is show exactly which account or server needs authorizing, and hand you the command.

## Troubleshooting

- **Buttons stop responding after a plugin update/reload** — an already-open panel keeps the old client bundle with a dead session. Navigate to another sidebar item and back (or reopen the Paseo window).
- **A wired provider errors about a path that doesn't exist** — Paseo builds its provider registry at daemon startup; config changes only take effect after `paseo restart`. Restart when no agents are mid-task.
- **A slot shows "login needed" although Paseo lists the provider** — listed means *configured*, not *authenticated*. Run the login command the panel shows.
- **An edit disappeared** — a running CLI session can rewrite its own config from memory. Make config changes when that provider isn't mid-session, or re-apply after.

## Security

Plugin backend code runs trusted and unsandboxed on your daemon machine (that is true of every Paseo plugin). Specifically, this one:

- reads MCP config files and, from credential-adjacent files, **only** the account email used for identity checks — never token material
- masks secret values in the UI by default; full values are shown only when you press **Reveal secrets**, and never leave your machine
- strips URL query strings from displayed summaries (some providers put tokens in URLs)
- backs up every config file before writing it, and refuses to overwrite a file it cannot parse
- changes Paseo providers through Paseo's own `config.patch` API, never by editing the daemon config file
- copies MCP *definitions* between accounts, never credentials — OAuth grants stay in each account's own store

## License

MIT
