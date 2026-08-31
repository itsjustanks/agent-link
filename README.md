<div align="center">

# paseo-agent-link

**One persistent Paseo chat with every connected model and account.**

[![Release](https://img.shields.io/github/v/release/itsjustanks/paseo-agent-link)](https://github.com/itsjustanks/paseo-agent-link/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Linux-informational)
![Paseo](https://img.shields.io/badge/Paseo-plugin-8A63D2)

</div>

**AgentLink** is Paseo's unified provider when installed. Its model picker behaves like Cursor: choose AgentRouter's automatic route or any model/account from connected Claude Code, Codex, and enabled Paseo ACP providers for the next turn without creating another chat, tab, or Paseo agent.

## Install

```sh
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/itsjustanks/paseo-agent-link/main/agent-link -o ~/.local/bin/agent-link
chmod +x ~/.local/bin/agent-link

agent-link add claude you@work.com
agent-link add codex you@home.com
agent-link auto
agent-link app install paseo
```

Or install the Paseo plugin directly:

```sh
paseo plugin add itsjustanks/paseo-agent-link --path apps/paseo --id agent-link
```

## One-chat model

Start a Paseo chat with the **AgentLink** provider. Its native model picker lists profiles such as:

```text
AgentRouter · Automatic route
Claude Fable 5 · you@work.com
Claude Opus 5 · you@work.com
GPT-5.6 Sol · you@home.com
GPT-5.6 Luna · you@home.com
Kimi K3 · Kimi Code CLI
Grok 4.6 · Grok
```

Changing the selection affects the next turn while preserving:

- the Paseo agent ID
- the same tab and visible history
- the canonical AgentLink transcript
- native backend session ownership for each account

When you return to an account, AgentLink resumes that account's native Claude or Codex session and bridges any turns it missed. It never archives the chat, creates a replacement agent, opens a terminal window, or moves subagents to another parent.

An unavailable account stays visible with its health state. Selecting it fails clearly in the same chat so you can choose another profile; AgentLink does not silently rotate or kill unrelated sessions.

**AgentRouter** is the default model inside AgentLink. It classifies the request locally, chooses the matching work type, and tries its configured model/account choices in order. Each target can inherit the chat mode or pin Plan, Auto, or Full access. Each work type can also require installed skills and add its own instructions. Configure it in **AgentLink → Orchestration**.

`agent-link auto` also installs one Paseo orchestration contract for every provider. Delegated work uses Paseo profiles and `create_agent`, remains a child in the current workspace by default, and creates a workspace/worktree only when isolation is explicit or genuinely required. The Orchestration tab shows whether the shared system prompt and the `paseo`, `paseo-handoff`, `paseo-advisor`, and `paseo-committee` skills are installed.

AgentLink exposes three consistent chat modes:

- **Plan** maps to the provider's read-only/planning mode.
- **Auto** maps to provider-native safety checks.
- **Full access** maps only to a real unrestricted provider mode, such as Claude Bypass, Codex Full Access, or an ACP mode named Full, Bypass, Allow All, YOLO, Unrestricted, or Dangerous.

If a connected provider cannot support the selected mode, a direct selection fails clearly in the same chat; AgentRouter moves to the next configured target before tool activity. Switching mode does not replace the Paseo chat or discard its private backend sessions.

Paseo owns the new-chat provider preference. Select AgentLink once in the composer and Paseo remembers that choice; the plugin does not overwrite an explicit user preference.

## Existing chats

`agent-link auto` installs the new **AgentLink** ACP provider and keeps the legacy `claude-auto`, `codex-auto`, and `agent-router` definitions so existing Paseo histories remain loadable. Legacy chats remain bound to their original account. New chats should use **AgentLink**.

The legacy Codex launcher escapes JSON-safe Unicode line separators on app-server stdout before Paseo reads it. This prevents a valid long transcript from being split into invalid JSON-RPC lines; it does not rewrite the transcript or change its thread ID.

No history is automatically archived, deleted, renamed, or migrated.

## Accounts and capacity

The Paseo plugin shows:

- every primary and managed Claude/Codex sign-in
- login and account identity without reading token material
- known usage windows, reset times, holds, and activity
- setup diagnostics and explicit account-limit probes
- provider CLI updates
- AgentRouter work types and ordered model/account choices
- memory protection for Paseo-owned compiler jobs

When Claude/Codex authentication is missing, expired, or attached to the wrong account, a top-level **Authentication required** card names exactly which account to select and gives one copyable command per affected sign-in. Kimi and Grok cards keep their exact `kimi login` and `grok login` commands visible beside Check setup. AgentLink never opens a terminal automatically.

A usage limit belongs to the signed-in account, not its local slot. Duplicate slots signed into the same account share one quota pool. Unknown capacity stays **unknown**.

Useful commands:

```sh
agent-link status
agent-link usage
agent-link insights 7
agent-link probe claude <model> --park
agent-link cooldown claude you@work.com hold
agent-link cooldown claude you@work.com clear
agent-link doctor
```

## Account management

Each login gets its own native configuration directory; credentials are not copied or swapped.

```sh
agent-link add <claude|codex> <email>
agent-link login <claude|codex> <email>
agent-link login <claude|codex> primary
agent-link remove <claude|codex> <email>
agent-link sync
```

A Claude conversation belongs to its creator's `CLAUDE_CONFIG_DIR`; a Codex thread belongs to its creator's `CODEX_HOME`. AgentLink preserves that ownership internally. The legacy launchers also resolve an existing thread's owner before resume, but never move it automatically.

## Provider CLI updates

```sh
agent-link toolchain enable
agent-link toolchain status
agent-link toolchain update
agent-link update
```

Active provider processes are skipped. Updates never kill an agent or change credentials.

## Memory protection

Paseo type-check and compiler processes are treated as job trees.

- One heavy job runs at a time by default.
- At 15% available memory or less, an eligible Paseo-owned job pauses.
- At 25% available memory, it continues.
- Provider sessions and terminal-owned processes are not touched.

```sh
AGENT_LINK_TYPECHECK_CONCURRENCY=1
AGENT_LINK_MEMORY_PAUSE_PERCENT=15
AGENT_LINK_MEMORY_RESUME_PERCENT=25
AGENT_LINK_RESOURCE_POLL_SECONDS=5
```

## Other tools and editors

The account-selecting launchers remain available for tools that accept a command:

```text
~/.agent-link/bin/claude-auto
~/.agent-link/bin/codex-auto
```

They choose an account when a new native session starts. They do not provide Paseo's one-chat cross-provider model switching; use the **AgentLink** provider for that.

## Safety

- AgentLink never reads, copies, backs up, or restores OAuth tokens.
- Never move `~/.agent-link`; Claude logins are bound to the literal config path.
- MCP definitions and preferences can sync, but OAuth grants remain per account.
- Sign-in may require an interactive terminal.
- AgentRouter routes a new turn inside the current chat; no post-failure continuation, replacement-agent creation, archive, or subagent reparenting runs.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| AgentLink is missing from the provider picker | Run `agent-link auto`, then `paseo reload` |
| A model says its account is unavailable | Open AgentLink → Accounts and repair or release that sign-in |
| AgentRouter chooses the wrong work type | Reorder or edit it in AgentLink → Orchestration |
| An old chat cannot find its thread | Keep its legacy provider and original account; do not convert it |
| Plugin buttons stop after an update | Reopen the AgentLink surface to load the new client bundle |

## License

MIT
