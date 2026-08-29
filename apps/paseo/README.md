<div align="center">

# agent-link for Paseo

**Every AI coding account you own and every MCP server across them — globally and per workspace.**

![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.5-8A63D2)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Plugin ID](https://img.shields.io/badge/plugin%20id-agent--link-lightgrey)

</div>

This is the Paseo app that ships with [agent-link](https://github.com/itsjustanks/agent-link). The CLI works perfectly well on its own; this is the same thing with a UI.

Two sidebar tabs:

![The Agent Link tab: a Routing card showing the auto-router installed for Claude and Codex, then each account with its state, park timer, credit note and launch count](../../docs/screenshots/agent-link.png)

## 👥 Agent Link

The surface opens on **AgentRouter**, followed by **Accounts, Limit recovery, and Memory protection**. **How to use AgentRouter** sits first and explains every tab and account check. Provider tabs — **Claude Code, Codex, Kimi Code, Grok, and custom additions** — live only inside Accounts. A free 30-second status check refreshes local state without starting a model. **Check setup** verifies a provider path, version, login, and models. **Test account limits** is the only check that spends a tiny model turn. The host watchdog separately scans recent stopped agents from every provider once a minute. Claude/Codex account-pinned aliases roll into their family tab.

- the **primary** account (the login your plain `claude` / `codex` uses), shown by email
- every saved **sign-in** with live state: logged in, login needed, or signed into the wrong account
- a clear count of saved sign-ins versus separate usage limits, with a warning when two sign-ins share one account and therefore one limit
- **Usage limits on each account row** — session and weekly windows, amount left, exact reset countdowns, the viewing device's local reset time, freshness, plan/model context, extra credits, and whether new chats can use it. No token material is read.
- **Activity in account Details** — an on-request Claude and Codex transcript scan for sessions, input/output/reasoning tokens, cache rate, context window, projects, and models actually used.
- **Credit state** — when an account has hit a spend limit, its row says so (Claude records the reason in its own config), instead of you finding out when an agent dies.
- **Rotation usage** — a bar and a count showing how many agents the router has handed each account and when it was last used, so you can see the rotation actually spreading. This is launch distribution, separate from the provider quota shown in **Available capacity**.
- **Last Paseo consumer** — routed launches retain the exact Paseo agent ID and working directory, so duplicate rows reveal which agent last used their shared quota.
- **Test account limits** — one tiny Claude turn per sign-in; refusing sign-ins stay unavailable and only a passing test releases them. The automatic status check never performs this paid check.
- **Memory protection tab** — live Paseo-owned TypeScript checks only. One check runs at a time; under critical pressure its compiler pauses instead of dying, then continues after recovery. Checks launched from Terminal are never touched.
- **+ Add account** — creates a sign-in and gives you the command to finish login
- **Automatic account selection** — one Dynamic Agent Link provider chooses an available account by priority, then least recent use, for each new chat. A running chat keeps its original account.
- **Model used panel and composer pill** — every agent shows the provider/model Paseo reports, the exact AgentLink sign-in when known, and the Paseo agent ID. AgentRouter separates its request reader and answer model. Hidden values stay explicitly unknown.
- **AgentRouter provider** — the first tab starts with its guide, then configures the request reader and ordered answer models through searchable pickers. Every answer runs as a concrete Paseo child. Choices may use any native, custom, or ACP provider.
- **Provider CLI updates** — the Accounts tab exposes AgentLink/provider CLI paths, the daily/manual schedule, safe run-now action, verified built-in recipes, and custom argument-by-argument recipes for every other provider Paseo lists. Live provider processes are skipped. This never performs a quota probe.
- **Paseo Codex resume routing** — `codex-auto` resolves the persisted thread from `PASEO_AGENT_ID` before account selection, because Paseo supplies app-server thread IDs over RPC after launch. A parked owner therefore hands its rollout to a healthy account instead of producing `no rollout found`.
- **Provider usage** — Codex limits come from rollout telemetry. Claude limits come from its interactive statusline or cached `/usage` result; Paseo's non-interactive Claude process cannot create that signal, so the panel gives the exact one-account command needed to capture it.
- **Park 3h / Resume** — take an account that hit its limit out of rotation and put it back
- **Create fixed-account provider** — one click adds a Paseo provider that always uses that sign-in. Three different Claude accounts provide three separate usage limits.

![The MCP tab: servers with coverage and live health, plus actions to add, import and sync definitions](../../docs/screenshots/mcp.png)

## 🔌 MCP

A universal manager for MCP servers across the machine. The global surface covers user-level Claude Code and Codex accounts, Kimi Code, Grok, and custom providers. It also lists MCP servers from every project registered with Paseo. A workspace panel reads that workspace's project `.mcp.json`. Selecting a server puts its health, definition, and account management in one full-width flow.

- **Servers** — search plus **All / Gaps / Issues**, with health and destination editing after selection. OAuth is shown only when a provider reports an account grant; headers, environment values, credential-bearing URL queries and command arguments are treated as inline credentials instead.
- **Automatic health** — runs on open and every 15 minutes while the surface is visible. HTTP servers get a real request (401/403 means **auth needed**); stdio servers get a binary-on-PATH check.
- **Workspace MCP connections** — open the panel on a Paseo workspace to see the exact `.mcp.json` servers associated with it and run OAuth from the correct project directory
- **Expand** a server for its destination table: present or missing per destination, add or remove there
- **Edit** — every destination's own definition, side by side. Different auth per account is expected and supported: change one account's header and save just that destination, or take one destination's version and **Use for ALL**.
- **Reveal secrets** — masked (`•••last4`) by default; one tap shows the stored values. Masked values are preserved on save, so editing one account can never copy its token into another. (Deliberate cross-account copies — **Add to all** and **Use for ALL** — do carry a definition's inline credentials, which is the point of those buttons.)
- **Rename everywhere** — rewrites a server's key across every config that has it (copy-then-delete, so a failure can never lose the definition)
- **Add server** — http or stdio, headers/env as `KEY=VALUE` lines, targeting all destinations or specific ones
- **Edit as JSON** — a `Fields | JSON` switch on every destination. You always type the shape people actually paste out of a README (Claude's), and TOML destinations are translated on the way in and out, so you never have to know that Codex spells headers `http_headers`. Validate before saving, Preview shows exactly what the destination will hold in its own format with any dropped keys named, and errors point at a line and column with a caret.
- **Paste JSON to import** — accepts `{"mcpServers":{…}}`, `{"servers":{…}}`, a single named entry, a bare definition, a `claude mcp add-json` command, or a TOML block; strips code fences, comments and trailing commas and tells you what it had to clean up. Unfilled placeholders like `<YOUR_TOKEN>` block the write until you say otherwise. Validation covers every server × destination pair before anything is written, so a bad import writes nothing at all rather than half of it.
- **Authorise or reconnect from the destination row** — when a provider reports OAuth, the definition and that account's connection live together. The daemon runs the right account's CLI and opens its computer's default browser. The authorization URL and callback target stay visible; Claude's manual flow accepts the browser's final callback URL directly in the panel. Sign out remains available.
- **Sync accounts** — pushes user-level definitions and project trust from each primary into its account slots

Every write backs up the target config first (last 20 kept — one "apply to all" is seven files in one press), replaces it atomically, and keeps the permissions it had, because these files hold bearer tokens. A config that exists but cannot be parsed is never overwritten. An edit is **lossless**: the stored entry is loaded and only the fields you changed are modified, so keys the plugin does not model — Claude's `type`, Codex's `enabled` and `startup_timeout_sec` — survive it.

Looking for the **Canvas** tab — live rendering and public links for everything your agents build? It grew into its own plugin: [paseo-canvas](https://github.com/itsjustanks/paseo-canvas). Install either, or both; they are independent.

### Built for narrow screens

Paseo plugins run on phones as well as desktop, so the panel uses one spacing scale that tightens on narrow layouts, buttons with real touch targets, account rows that put the identity on its own line above the detail, and an MCP destination table that stacks instead of squeezing labels to nothing.

## Install

**With the CLI** — one command:

```sh
agent-link app install paseo
```

On Paseo 0.7+, it installs from Git and hands updates to Paseo's candidate validation and rollback flow. Re-run it to check for updates; `agent-link app remove paseo` uninstalls. Older Paseo versions use the directory installer.

**Directly with Paseo 0.7+** — no clone or AgentLink CLI needed:

```sh
paseo plugin add itsjustanks/agent-link --path apps/paseo
paseo plugin update agent-link
```

The default branch tracks updates. `--ref <tag-or-commit>` creates a pinned install instead.

**Local development**:

```sh
git clone https://github.com/itsjustanks/agent-link
```

1. **Settings → Plugins**
2. Turn on **Enable plugins** — the global switch for every configured plugin
3. Paste the absolute path to `agent-link/apps/paseo` into **Plugin directory**
4. Leave **Plugin installation ID** blank; `paseo-plugin.json` supplies `agent-link`
5. Press **Install directory**

No `npm install` step: the plugin imports only modules Paseo provides at runtime, and Paseo compiles it on install. The same screen has **Reload**, **Disable**, **Remove** and **Logs** per plugin — Logs is the first place to look if a tab misbehaves. Removing a plugin deletes its configuration, never your source directory.

**Updates come to you.** Paseo checks Git-managed sources and validates each candidate before activation. The Agent Link tab compares release numbers and starts the same Paseo update flow; a local build ahead of the release is never offered a downgrade.

**Working on it?** `agent-link app install paseo --link` registers your checkout in place instead of copying, so `paseo plugin reload agent-link` picks up an edit.

Requires Paseo with plugins enabled. Git updates and the newest client integrations target Paseo 0.7+.

**Nothing else is required.** Every provider and account it finds is one you already have — the plugin installs no software and creates no accounts. Providers you don't use simply don't appear.

### Do you need the CLI?

No, for most of it. This panel reads the account directories and writes MCP configuration on its own — accounts and MCP work with the plugin alone.

**Routing is the exception.** A Paseo provider runs a command, so the auto-router needs the launcher script that `agent-link auto` writes. The Agent Link tab therefore shows an **Install the agent-link CLI** card when it is missing: one press fetches a single file into `~/.local/bin`, writes the launchers, and routing becomes installable from the panel. The `curl` command sits beside the button if you would rather do it yourself, and the card disappears once the CLI is found.

### Optional: the agent-link CLI

[**agent-link**](https://github.com/itsjustanks/agent-link) is the companion CLI that creates and logs in account slots (`agent-link add claude you@work.com`) and can hot-switch which account the plain `claude` / `codex` command uses. The plugin is fully standalone without it — it reads whatever slots exist and does its own MCP sync — but with agent-link installed, logins become one command and the panel points you at it. The panel also reads hand-rolled slot layouts in `~/.claude-accounts` / `~/.codex-accounts`.

### Authentication by account

MCP *definitions* sync between accounts; MCP *grants* do not — a server is authorized once per account, which is what "server X is not connected" actually means. Open the server, then press **Connect OAuth** or **Reconnect** on the account row. The daemon opens its computer's default browser and keeps copyable authorization/callback URLs in the panel; no token is pasted into Agent Link. A remote daemon also shows the exact fallback command:

```sh
CLAUDE_CONFIG_DIR="~/.agent-link/accounts/claude/you@work.com" claude mcp login <server>
```

For project-scoped servers, open **MCP connections** on the Paseo workspace. OAuth launches from that workspace's `.mcp.json` directory, so the provider resolves the exact raw server name. The plugin reads but never edits project definitions.

### Global and project scope

The sidebar MCP surface manages **user-level** servers available across projects. The workspace MCP panel reads the selected repository's `.mcp.json` and manages its account grants; project definitions remain read-only.

## About rate limits and failover

Paseo alone has no automatic account failover. Agent Link adds restart-based recovery for routed agents: the failed turn ends, the exact account/model refusal is recorded, and the same conversation is relaunched through the next eligible account. Claude's durable hook and the watchdog's every-provider scan work before the panel has opened; the panel's live sentry is the second path. Codex and AgentRouter recover automatically when a recorded route has a healthy alternate. Direct, Kimi, Grok and other single-account providers are reported as blocked for an explicit retry or handoff because silently creating a different-provider conversation would lose continuity.

- **Limits** — provider quota percentage used and available, named window, reset countdown, freshness, credits, and routing state per account, captured from that account's own CLI session state without reading its access token.
- **Activity · 7 days** — an on-request Claude and Codex transcript scan for sessions, tokens, cache rate, context window, projects, and models actually used.
- **Credit state** — when an account has hit a spend limit, its row says so (Claude records the reason in its own config), instead of you finding out when an agent dies.
- **Rotation usage** — a bar and a count showing how many agents the router has handed each account and when it was last used, separate from provider quota.
- **+ Add account** — creates the slot for a new account and hands you the one command to finish sign-in. The browser step itself stays in a terminal because both CLIs ask you to paste a code back; the row turns green once you have (and flags a mismatch if you signed in as someone else)
- **Auto-router** — one provider that picks a live account per launch, so agents spread across accounts without you choosing
- **Park / Resume** — account-wide limits stop every model; a named-model refusal excludes only that account/model pair, visibly on the account row
- **Pool count** — see how many *independent* limits you actually have, with duplicates flagged

A running turn still keeps the account it started on. Recovery starts only after that turn has stopped, then preserves the transcript while changing the account-backed process.

Paseo's built-in usage figure reads the primary accounts only (`~/.claude`, `~/.codex`). Agent Link's **Usage limits** also covers managed sign-ins by reading the small usage snapshots its session hooks already capture; it never reads access tokens.

## What may still use the terminal

Finishing a new CLI account login may require a code in a terminal. MCP OAuth can start directly from **Connect OAuth** in the panel when Paseo's daemon is on this Mac; for a remote daemon, the panel gives the provider- and account-specific command to run on that machine.

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
