<div align="center">

# 9Router Agent Link

**A Paseo panel for a local [9router](https://github.com/decolua/9router).**

![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.5-8A63D2)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Plugin ID](https://img.shields.io/badge/plugin%20id-agent--link-lightgrey)

</div>

9router holds your Claude Code and Codex subscriptions, tracks their quotas, rotates between accounts and falls back when one runs out. This plugin is the Paseo front for it: set it up, watch it, and put its models where Paseo's model picker can see them.

Requires 9router (`npm install -g 9router`). Without it the panel shows an install guide and nothing else.

## Install

```sh
paseo plugin add itsjustanks/paseo-plugin-9router --path apps/paseo --id agent-link
paseo plugin reload agent-link
```

For local development from a checkout:

```sh
agent-link app install paseo --link
paseo plugin reload agent-link
```

Then open **9Router** in the sidebar.

## Tabs

**Setup** is a checklist that doubles as the wizard — installed, running, password saved, an account connected, a CLI routed. It carries the `npm install -g 9router` command when the binary is missing, a Start button, and the dashboard password prefilled with 9router's first-run default so a fresh install is one press.

**Accounts** lists every connection grouped by provider, with a quota bar per window (5-hour, weekly, whatever that provider reports) and its reset time. Claude signs in by pasting the code from its approval page; Codex hands off to 9router's loopback listener and polls. A **Parked accounts** panel appears when 9router has taken an account out of rotation, showing the error that did it.

**Models** writes one **9Router** provider holding every model 9router serves, tests any id with a real completion, exposes a model 9router's catalogue lacks, and manages aliases and combos. Paseo's stock Claude and Codex providers keep their matching models too, so an existing chat pinned to one keeps working.

**Keys** manages API keys and combos. A key is listed by name and its last four characters; the full value only ever travels from "Copy key" to the clipboard. Combos are built by tapping models in fallback order.

**Power-ups** matches 9router's hardcoded `claude-cli/<version>` to the one you actually have — which is what unblocks a model Anthropic gates behind a newer client — and can run `claude update` first. Reversible, backed up beside the file it edits, and re-read from disk because a package upgrade silently reverts it.

**Tuning** switches 9router's token savers — RTK (compresses tool output), Caveman (terser system prompt, lite or full), Ponytail (YAGNI coding style), Headroom (external context compression) — and shows the combo strategy and sticky round-robin limit.

**Usage** reports requests, prompt/cached/completion tokens and the equivalent API cost, broken down by provider and by model.

**Logs** tails 9router's console every 4 seconds, colour-coded, copyable. This is where a routing decision or failure explains itself.

## What routing actually changes

Toggling a CLI in **Setup** calls 9router's own endpoint, which rewrites that CLI's config:

- Claude Code → the `env` block in `~/.claude/settings.json`
- Codex → `model_provider` and `[model_providers.9router]` in `~/.codex/config.toml`

That is machine-wide. Every launch of that binary routes through 9router, whether Paseo started it or you did. Paseo's stock providers need no further wiring as a result.

Restoring Claude also clears any `ANTHROPIC_DEFAULT_*` value still pointing at a 9router id — 9router's own reset list misses some of those slots, which would otherwise leave a model slot pointing at an id that no longer resolves.

## Design notes

- **The dashboard cannot be embedded.** Plugin surfaces are React Native with no WebView, and the SDK exposes no browser-tab API. "Open dashboard" uses the system browser; ⌘⇧B opens a Paseo browser tab to paste into.
- **No token material is read.** The panel reads account identity and provider-reported usage. The API key is reported as present plus its last four characters; the dashboard password is written to `9router.json` (mode 600) and never returned.
- **One provider, every pool.** 9router translates each pool into the Claude wire format, so a single Claude-extended provider serves the whole catalogue. Splitting it by pool would only mirror 9router's internals into a menu.
- **A stock-provider chat sends a bare model name.** 9router routes by pool prefix, so `claude-opus-5` with no `cc/` reaches nothing and returns `model_not_found` — which Claude Code reports as "model may not exist or you may not have access". An alias fixes it; the 9Router provider avoids it by sending prefixed ids.
- **Reads are cheap and never spend a turn.** The one exception is the Test button in **Models**, which sends a 16-token completion because that is the only honest way to answer "is this reachable".

## Troubleshooting

**The panel says 9router is not running.** Press Start, or run `9router` in a terminal to see why it will not.

**Accounts and quotas are empty.** The panel needs the dashboard password to reach 9router's management API. Save it under Setup.

**An account is parked and stays parked.** 9router clears an account's error state only after a successful request from that account — but a parked account is excluded from selection, so it never gets one. Fix the cause, then press Clear in **Accounts**.

**A model 400s with a version message.** 9router sends its own hardcoded Claude Code version, not yours. A model gated behind a newer client fails until 9router bumps it.

**Nothing appears in the picker after Sync.** Check `paseo plugin logs agent-link`, then reload Paseo. Sync writes a `ninerouter` provider and refreshes it; it never restarts the daemon.

## License

MIT
