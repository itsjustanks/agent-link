#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-style.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p \
  "$fixture_root/.claude" \
  "$fixture_root/.codex" \
  "$fixture_root/.paseo" \
  "$fixture_root/agent-link/accounts/claude/claude@example.com" \
  "$fixture_root/agent-link/accounts/codex/codex@example.com"
printf '%s\n' '{}' > "$fixture_root/.claude/settings.json"
printf '%s\n' '{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"if [ -n \"$PASEO_TERMINAL_ID\" ]; then \"${PASEO_HOOK_CLI:-paseo}\" hooks claude Stop; fi"}]},{"hooks":[{"type":"command","command":"keep-this-hook"}]}],"StopFailure":[{"matcher":"rate_limit|billing_error","hooks":[{"type":"command","command":"agent-link refused claude"}]}]}}' > "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json"
printf '%s\n' '{"daemon":{"appendSystemPrompt":"Session: [brief context]\\n\\n## Your role\\n\\n- keep this"}}' > "$fixture_root/.paseo/config.json"

HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root/agent-link" \
  "$repo_root/agent-link" style install >/dev/null

grep -q '# Response style' "$fixture_root/.claude/output-styles/concise.md"
grep -q '# Response style' "$fixture_root/.codex/AGENTS.md"
grep -q 'Lead with the result or the answer' "$fixture_root/agent-link/accounts/codex/codex@example.com/AGENTS.md"
! grep -q 'delegate useful parallel work' "$fixture_root/.codex/AGENTS.md"
! grep -q '## Orchestration' "$fixture_root/.codex/AGENTS.md"
! grep -q '## Orchestration' "$fixture_root/.claude/output-styles/concise.md"
test "$(jq -r '.outputStyle' "$fixture_root/.claude/settings.json")" = "Concise"
test "$(jq -r '.outputStyle' "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json")" = "Concise"
! rg -q 'PASEO_TERMINAL_ID|PASEO_HOOK_CLI|paseo.*hooks claude' "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json"
rg -q 'keep-this-hook' "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json"
rg -q 'agent-link refused claude' "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json"
test "$(jq -r '.daemon.appendSystemPrompt | startswith("<!-- agent-link:paseo-contract:start -->")' "$fixture_root/.paseo/config.json")" = "true"
test "$(jq -r '.daemon.autoArchiveAfterMerge' "$fixture_root/.paseo/config.json")" = "false"
test "$(jq -r '.daemon.enableTerminalAgentHooks' "$fixture_root/.paseo/config.json")" = "false"
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Use native subagents for quick same-provider'
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Use Paseo subagents for cross-provider work'
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Use AgentLink only when requested or no suitable direct provider/account is available'
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q '<!-- agent-link:paseo-contract:end -->'
! rg -q 'Session: \[brief context\]' "$fixture_root/.paseo/config.json"
rg -q 'keep this' "$fixture_root/.paseo/config.json"

before="$(shasum -a 256 "$fixture_root/.paseo/config.json" | awk '{print $1}')"
HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root/agent-link" \
  "$repo_root/agent-link" style install >/dev/null
after="$(shasum -a 256 "$fixture_root/.paseo/config.json" | awk '{print $1}')"
test "$before" = "$after"

printf '%s\n' '{"daemon":{"appendSystemPrompt":"## Response contract\nold\n\n## Your role\nold\n\n## Accounts and limits\nold\n\n## Paseo MCP approval\nold\n\n## Dev servers — the biggest cost on this machine\nkeep safe server rules\n\n## Finishing\nold\n\n## Agent hygiene (daemon stability)\nold"}}' > "$fixture_root/.paseo/config.json"
HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root/agent-link" \
  "$repo_root/agent-link" style install >/dev/null
! rg -q '## Accounts and limits|## Paseo MCP approval|## Agent hygiene' "$fixture_root/.paseo/config.json"
! rg -q 'keep safe server rules' "$fixture_root/.paseo/config.json"
! rg -q '## Finishing' "$fixture_root/.paseo/config.json"
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Give independent edits separate worktrees'

status="$(HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root/agent-link" "$repo_root/agent-link" style status)"
grep -q 'Claude response style: installed' <<< "$status"
grep -q 'Codex response style: installed' <<< "$status"

echo "response style fixture passed"
