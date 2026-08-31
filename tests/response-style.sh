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
printf '%s\n' '{}' > "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json"
printf '%s\n' '{"daemon":{"appendSystemPrompt":"Session: [brief context]\\n\\n## Your role\\n\\n- keep this"}}' > "$fixture_root/.paseo/config.json"

HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root/agent-link" \
  "$repo_root/agent-link" style install >/dev/null

grep -q -- '- Asked: the original request.' "$fixture_root/.claude/output-styles/concise.md"
grep -q -- '- Goal: the intended end state.' "$fixture_root/.codex/AGENTS.md"
grep -q -- '- Next: the most useful immediate action, only when relevant.' "$fixture_root/.claude/output-styles/concise.md"
grep -q -- '- Next: the most useful immediate action, only when relevant.' "$fixture_root/.codex/AGENTS.md"
grep -q 'Runtime model identity comes from AgentLink' \
  "$fixture_root/agent-link/accounts/codex/codex@example.com/AGENTS.md"
grep -q 'Never call Paseo `create_terminal` for ordinary shell commands' \
  "$fixture_root/.codex/AGENTS.md"
grep -q 'Never call Paseo `create_terminal` for ordinary shell commands' \
  "$fixture_root/.claude/output-styles/concise.md"
grep -q 'read `~/.agents/skills/paseo/SKILL.md` completely' \
  "$fixture_root/.claude/output-styles/concise.md"
grep -q 'Omit `workspaceId` for ordinary delegation' \
  "$fixture_root/.codex/AGENTS.md"
grep -q 'Never create a workspace merely to delegate, retry, continue, investigate, or switch model/provider/account' \
  "$fixture_root/.codex/AGENTS.md"
test "$(jq -r '.outputStyle' "$fixture_root/.claude/settings.json")" = "Concise"
test "$(jq -r '.outputStyle' "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json")" = "Concise"
test "$(jq -r '.daemon.appendSystemPrompt | startswith("<!-- agent-link:paseo-contract:start -->")' "$fixture_root/.paseo/config.json")" = "true"
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q -- '- Next: the most useful immediate action, only when relevant.'
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Never call Paseo `create_terminal` for ordinary shell commands'
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Use Paseo `create_agent`'
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
rg -q 'keep safe server rules' "$fixture_root/.paseo/config.json"
! rg -q '## Finishing' "$fixture_root/.paseo/config.json"
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Omit `workspaceId` for ordinary delegation'

status="$(HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root/agent-link" "$repo_root/agent-link" style status)"
grep -q 'Claude orchestration contract: installed' <<< "$status"
grep -q 'Codex orchestration contract: installed' <<< "$status"

echo "response style fixture passed"
