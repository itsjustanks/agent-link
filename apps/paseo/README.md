<div align="center">

# agent-link for Paseo

**Every AI coding account you own and every MCP server across them — in two tabs.**

![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.5-8A63D2)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Plugin ID](https://img.shields.io/badge/plugin%20id-agent--link-lightgrey)

</div>

This is the Paseo app that ships with [agent-link](https://github.com/itsjustanks/agent-link). The CLI works perfectly well on its own; this is the same thing with a UI.

Two sidebar tabs:

![The Agent Link tab: a Routing card showing the auto-router installed for Claude and Codex, then each account with its state, park timer, credit note and launch count](../../docs/screenshots/agent-link.png)

## 👥 Agent Link

One card per provider connector — **Claude Code, Codex, Kimi Code, Grok** — each with a health dot and Paseo's own diagnostic one click away. Inside each card, a table of every account under it:

- the **primary** account (the login your plain `claude` / `codex` uses), shown by email
- every **account slot** with live state: 🟢 logged in · 🟠 login needed · 🔴 wrong account (the slot folder says one email, the login inside is another)
- a **pool summary** — "5 logged-in entries → 4 independent quota pools" — and a ⚠ badge on any two entries signed into the *same* account, since a rate limit belongs to an account, not to a slot
- **Available capacity** — always shows each account's captured provider quota windows, percentage left, reset time, and whether it is ready, nearing its limit, held, or cooling down. No token material is read. **Activity details** remains an on-request transcript scan for sessions, input/output tokens, cache rate, and models actually used.
- **Credit state** — when an account has hit a spend limit, its row says so (Claude records the reason in its own config), instead of you finding out when an agent dies.
- **Rotation usage** — a bar and a count showing how many agents the router has handed each account and when it was last used, so you can see the rotation actually spreading. This is launch distribution, separate from the provider quota shown in **Available capacity**.
- **Memory guard** — one Paseo-owned TypeScript check runs at a time; under critical pressure it is paused, not killed, and continued after the machine recovers. Checks launched from Terminal are never touched.
- **+ Add account** — creates the slot for a new account and hands you the one command to finish sign-in. The browser step itself stays in a terminal because both CLIs ask you to paste a code back; the row turns green once you have (and flags a mismatch if you signed in as someone else)
- **Auto-router** — one click wires a single `Claude (Dynamic Agent Link)` / `Codex (Dynamic Agent Link)` provider that sends each new agent to the least-recently-used live account. Pick that one provider and your accounts get used automatically; a running agent is never re-routed.
- **Park 3h / Resume** — take an account that hit its limit out of rotation and put it back
- **Wire into Paseo** — one click adds that account as a Paseo custom provider (`extends` the native integration, pointing `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at the slot). Each wired account is an independent quota pool: five agents across three Claude accounts genuinely run on three separate rate limits. A banner reminds you Paseo loads new providers at the next daemon restart.

![The MCP tab: 29 servers with a coverage bar each, filters for All, Gaps and Issues, and buttons to add a server, paste JSON, sync accounts and run a health check](../../docs/screenshots/mcp.png)

## 🔌 MCP

A universal manager for **user-level** MCP servers across every provider on the machine — Claude Code and Codex primaries (labeled with their actual account), every wired provider, every account slot, plus Kimi Code and Grok. One row per server, one column-equivalent per destination:

- **Sticky header** with search and **All / Gaps / Issues** tabs
- **Health check** — HTTP servers get a real request (a 401/403 is reported as **auth needed**, which is the honest answer to "does this need authorizing?"); stdio servers get a binary-on-PATH check. 🟢 / 🟠 / 🔴 per server.
- **Expand** a server for its destination table: present or missing per destination, add or remove there
- **Edit** — every destination's own definition, side by side. Different auth per account is expected and supported: change one account's header and save just that destination, or take one destination's version and **Use for ALL**.
- **Reveal secrets** — masked (`•••last4`) by default; one tap shows the stored values. Masked values are preserved on save, so editing one account can never copy its token into another. (Deliberate cross-account copies — **Add to all** and **Use for ALL** — do carry a definition's inline credentials, which is the point of those buttons.)
- **Rename everywhere** — rewrites a server's key across every config that has it (copy-then-delete, so a failure can never lose the definition)
- **Add server** — http or stdio, headers/env as `KEY=VALUE` lines, targeting all destinations or specific ones
- **Edit as JSON** — a `Fields | JSON` switch on every destination. You always type the shape people actually paste out of a README (Claude's), and TOML destinations are translated on the way in and out, so you never have to know that Codex spells headers `http_headers`. Validate before saving, Preview shows exactly what the destination will hold in its own format with any dropped keys named, and errors point at a line and column with a caret.
- **Paste JSON to import** — accepts `{"mcpServers":{…}}`, `{"servers":{…}}`, a single named entry, a bare definition, a `claude mcp add-json` command, or a TOML block; strips code fences, comments and trailing commas and tells you what it had to clean up. Unfilled placeholders like `<YOUR_TOKEN>` block the write until you say otherwise. Validation covers every server × destination pair before anything is written, so a bad import writes nothing at all rather than half of it.
- **Authorise from the panel** — OAuth servers are authorised once per account, and this runs `claude mcp login` / `codex mcp login` under the right account for you, shows the URL to open, and watches for it to finish. Sign out is there too. (The callback lands on the daemon machine's localhost, so when Paseo's daemon is somewhere else the panel hands you the command instead of pretending.)
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

It copies the plugin into `<paseo home>/plugins/agent-link`, installs its dependencies, typechecks it, registers it under the id `agent-link`, and confirms the daemon has it running. Re-run it to upgrade; `agent-link app remove paseo` uninstalls; `agent-link update` updates the CLI and this panel together. If Paseo, Node or the plugins switch is missing, it says which and stops rather than half-installing.

**From the Paseo UI** — no CLI needed:

```sh
git clone https://github.com/itsjustanks/agent-link
```

1. **Settings → Plugins**
2. Turn on **Enable plugins** — the global switch for every configured plugin
3. Paste the absolute path to `agent-link/apps/paseo` into **Plugin directory**
4. Leave **Plugin installation ID** blank; `paseo-plugin.json` supplies `agent-link`
5. Press **Install directory**

No `npm install` step: the plugin imports only modules Paseo provides at runtime, and Paseo compiles it on install. The same screen has **Reload**, **Disable**, **Remove** and **Logs** per plugin — Logs is the first place to look if a tab misbehaves. Removing a plugin deletes its configuration, never your source directory.

**Updates come to you.** The Agent Link tab checks GitHub once per session and shows an **Update now** card when `main` has moved past the installed build; one press runs the installer, and a Reload in Settings → Plugins finishes it if the panel doesn't pick it up on its own.

**Working on it?** `agent-link app install paseo --link` registers your checkout in place instead of copying, so `paseo plugin reload agent-link` picks up an edit.

Requires Paseo ≥ 0.5 with plugins enabled. Tested against 0.5.0-beta.5.

**Nothing else is required.** Every provider and account it finds is one you already have — the plugin installs no software and creates no accounts. Providers you don't use simply don't appear.

### Do you need the CLI?

No, for most of it. This panel reads the account directories and writes MCP configuration on its own — accounts and MCP work with the plugin alone.

**Routing is the exception.** A Paseo provider runs a command, so the auto-router needs the launcher script that `agent-link auto` writes. The Agent Link tab therefore shows an **Install the agent-link CLI** card when it is missing: one press fetches a single file into `~/.local/bin`, writes the launchers, and routing becomes installable from the panel. The `curl` command sits beside the button if you would rather do it yourself, and the card disappears once the CLI is found.

### Optional: the agent-link CLI

[**agent-link**](https://github.com/itsjustanks/agent-link) is the companion CLI that creates and logs in account slots (`agent-link add claude you@work.com`) and can hot-switch which account the plain `claude` / `codex` command uses. The plugin is fully standalone without it — it reads whatever slots exist and does its own MCP sync — but with agent-link installed, logins become one command and the panel points you at it. The panel also reads hand-rolled slot layouts in `~/.claude-accounts` / `~/.codex-accounts`.

### Authentication by account

MCP *definitions* sync between accounts; MCP *grants* do not — a server is authorized once per account, which is what "server X is not connected" actually means. For an OAuth HTTP server, open it in the MCP tab and press **Connect OAuth** beside each Claude or Codex account. Agent Link starts that account's CLI login and opens the provider's browser sign-in; no token is pasted into the panel. A remote daemon also shows the exact fallback command:

```sh
CLAUDE_CONFIG_DIR="~/.agent-link/accounts/claude/you@work.com" claude mcp login <server>
```

Project-scoped servers (defined in a repo's `.mcp.json`) are listed too, since they also need authorizing per account even though this plugin never edits them.

### Scope: user-level, not project-level

The MCP tab manages **user-level** (global) servers — each provider's own config, available in all your projects. A repo's own project-level servers (`.mcp.json` in the repository) belong to that repo and are never read or written.

## About rate limits and failover

Paseo has no automatic provider failover: an agent that hits a usage limit stops with an error and keeps its workspace — it does not move itself to another account. Three things reduce the pain, and the tab exposes all of them:

- **Available capacity** — provider quota percentage left and reset time per account, captured from that account's own CLI session state without reading its access token.
- **Activity details** — an on-request transcript scan for sessions, tokens, cache rate, and models actually used.
- **Credit state** — when an account has hit a spend limit, its row says so (Claude records the reason in its own config), instead of you finding out when an agent dies.
- **Rotation usage** — a bar and a count showing how many agents the router has handed each account and when it was last used, separate from provider quota.
- **+ Add account** — creates the slot for a new account and hands you the one command to finish sign-in. The browser step itself stays in a terminal because both CLIs ask you to paste a code back; the row turns green once you have (and flags a mismatch if you signed in as someone else)
- **Auto-router** — one provider that picks a live account per launch, so agents spread across accounts without you choosing
- **Park / Resume** — take an exhausted account out of rotation; new agents skip it until it recovers
- **Pool count** — see how many *independent* limits you actually have, with duplicates flagged

A running agent still keeps the account it started on; nothing re-routes mid-task (that is what breaks sessions).

Paseo's built-in usage figure reads the primary accounts only (`~/.claude`, `~/.codex`). Agent Link's **Available capacity** also covers per-account slots by reading the small quota snapshots its session hooks already capture; it never reads access tokens.

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
