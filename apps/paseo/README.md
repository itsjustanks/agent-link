<div align="center">

# agent-link for Paseo

**One chat, every connected Paseo model/account.**

![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.5-8A63D2)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Plugin ID](https://img.shields.io/badge/plugin%20id-agent--link-lightgrey)

</div>

This plugin adds the **AgentLink** surface for account capacity, provider health, AgentRouter orchestration, toolchains, and memory protection. The `agent-link auto` command installs the unified **AgentLink** ACP provider used by Paseo's native model picker.

## Cursor-style chat behavior

Create one Paseo chat with **AgentLink**, then use its model picker to choose **AgentRouter · Automatic route** or any connected Claude/Codex account and enabled Paseo ACP model. Account email or provider name is included in every profile label.

A model change applies to the next turn while the Paseo agent ID, tab, and canonical transcript stay fixed. AgentLink resumes a private native backend session for each account and bridges missed turns when you switch back.

AgentRouter classifies locally, then uses the configured work type and ordered model/account choices. A clean launch failure can move to the next choice before tool activity, without creating another Paseo agent.

It does not:

- create a replacement Paseo agent or terminal window
- archive or hide the original chat
- run an automatic continuation after a failure
- move subagents between parent chats
- silently choose a different account than the selected profile

If an account is unavailable, the turn reports that state in the same chat and waits for you to choose another model/account.

## AgentLink surface

The sidebar surface has **Accounts**, **Orchestration**, and **Memory protection**:

- connected primary and managed sign-ins
- account identity, login state, usage evidence, reset times, and holds
- activity details loaded on request
- setup diagnostics and explicit paid account probes
- add, remove, prefer, hold, and release account controls
- AgentRouter work types with model/account/mode ordering, required skills, and scoped instructions
- safe provider-CLI update controls
- Paseo-owned compiler memory protection

No token material is read. Health polling is read-only and never spends a model request; unknown capacity remains explicitly unknown until a provider reports it or the user explicitly runs a limit probe.

## Install

With the CLI:

```sh
agent-link app install paseo
agent-link auto
```

Directly with Paseo:

```sh
paseo plugin add itsjustanks/paseo-agent-link --path apps/paseo --id agent-link
paseo plugin update agent-link
```

For local development:

```sh
agent-link app install paseo --link
paseo plugin reload agent-link
```

Paseo validates Git-managed plugin candidates before activation. Removing the plugin removes its configuration, not account data or chat history.

## Existing chats

AgentLink retains legacy `claude-auto`, `codex-auto`, and `agent-router` provider definitions for existing histories. Those chats stay attached to their original native account; no conversion or archive is attempted. The legacy Codex launcher also protects Paseo's JSON-RPC reader from Unicode line separators without changing transcript bytes. Use **AgentLink** for new chats.

## CLI requirement

The panel can inspect accounts without the CLI. The one-chat provider requires the CLI-installed ACP runtime:

```sh
agent-link auto
```

This writes `~/.agent-auth/bin/agent-link-acp`, adds the **AgentLink** provider to Paseo config, caches connected provider model catalogs, and requests a provider reload. It does not restart the daemon or active agents. Paseo remembers AgentLink after it is selected once; the plugin does not overwrite an explicit composer preference.

## Rate limits

AgentLink displays provider-owned usage evidence and explicit holds. It does not infer health from a successful login. A selected profile that is held, signed out, or unavailable refuses the turn without replacing the chat.

## Modes and orchestration

AgentLink exposes **Plan**, **Auto**, and **Full access**. Claude and Codex receive their native equivalents; connected ACP providers are matched from the modes they report. Full access never falls back to a safer or unrelated mode: unsupported direct selections report the incompatibility, while AgentRouter can try its next target before tool activity.

In **AgentLink → Orchestration**, each ordered target can inherit the chat mode or pin one of these modes. Each work type can name up to 24 installed skills and add scoped instructions. AgentRouter resolves every required `SKILL.md` before starting a paid provider turn and refuses when one is missing.

Claude usage comes from provider-owned interactive status or cached usage state. Codex usage comes from rollout telemetry. Account-limit probes are explicit because they spend a small model turn.

## Memory protection

Only eligible Paseo-owned type-check/compiler process trees are managed. One heavy job runs at a time; critical memory pressure pauses it and recovery resumes it. Provider agents and terminal-owned processes are never killed.

## What may open Terminal

Only an explicit login or provider authentication flow may need Terminal. Normal AgentLink turns and model changes run inside the existing Paseo chat.

## Troubleshooting

- **AgentLink is absent** — run `agent-link auto`, then `paseo reload`.
- **Profiles are missing** — repair the sign-in in AgentLink → Accounts, run `agent-link auto`, and start or reload the AgentLink session.
- **Automatic picked the wrong work type** — edit the order in AgentLink → Orchestration.
- **An old chat fails to resume** — run `agent-link auto`, keep its legacy provider and original account, then reload that chat.
- **Plugin controls stop after reload** — reopen the AgentLink surface to load the new bundle.

## Security

Plugin backend code is trusted daemon code. It reads account identity and provider-owned usage state, never OAuth token material. It does not archive chats, spawn continuation agents, or switch an in-flight native process.

## License

MIT
