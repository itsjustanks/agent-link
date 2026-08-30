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
test "$(jq -r '.outputStyle' "$fixture_root/.claude/settings.json")" = "Concise"
test "$(jq -r '.outputStyle' "$fixture_root/agent-link/accounts/claude/claude@example.com/settings.json")" = "Concise"
test "$(jq -r '.daemon.appendSystemPrompt | startswith("## Response contract")' "$fixture_root/.paseo/config.json")" = "true"
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q -- '- Next: the most useful immediate action, only when relevant.'
jq -r '.daemon.appendSystemPrompt' "$fixture_root/.paseo/config.json" | grep -q 'Never call Paseo `create_terminal` for ordinary shell commands'
! rg -q 'Session: \[brief context\]' "$fixture_root/.paseo/config.json"
rg -q 'keep this' "$fixture_root/.paseo/config.json"

echo "response style fixture passed"
