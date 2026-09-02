#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-auth.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$fixture_root/home/.codex" "$fixture_root/agent-link/state/pools" "$fixture_root/bin"
printf '%s\n' 'authentication failed — run: agent-link login all' \
  > "$fixture_root/agent-link/state/pools/hold-codex-primary"
printf '%s\n' 'auto: authentication failed — login required' \
  > "$fixture_root/agent-link/state/pools/reason-codex-primary"

printf '%s\n' '#!/bin/sh' \
  'printf "%s\\n" "$*" >> "$AUTH_TEST_LOG"' \
  'mkdir -p "$HOME/.codex"' \
  'printf "%s\\n" "{}" > "$HOME/.codex/auth.json"' \
  > "$fixture_root/bin/codex"
chmod +x "$fixture_root/bin/codex"

HOME="$fixture_root/home" \
AGENT_LINK_HOME="$fixture_root/agent-link" \
AUTH_TEST_LOG="$fixture_root/codex.log" \
PATH="$fixture_root/bin:/usr/bin:/bin" \
  "$repo_root/agent-link" login codex primary >/dev/null

grep -qx 'login' "$fixture_root/codex.log"
test -f "$fixture_root/home/.codex/auth.json"
test ! -e "$fixture_root/agent-link/state/pools/hold-codex-primary"
test ! -e "$fixture_root/agent-link/state/pools/reason-codex-primary"
grep -q 'agent-link login \$p \$e' "$repo_root/agent-link"

mkdir -p "$fixture_root/agent-link/accounts/claude/person@icloud.com"
printf '%s\n' '{"oauthAccount":{"emailAddress":"Person@iCloud.com"}}' \
  > "$fixture_root/home/.claude.json"
printf '%s\n' '{"oauthAccount":{"emailAddress":"PERSON@ICLOUD.COM"}}' \
  > "$fixture_root/agent-link/accounts/claude/person@icloud.com/.claude.json"
next="$(HOME="$fixture_root/home" AGENT_LINK_HOME="$fixture_root/agent-link" PATH="/usr/bin:/bin" \
  "$repo_root/agent-link" next claude)"
test "$next" = 'person@icloud.com'
status="$(HOME="$fixture_root/home" AGENT_LINK_HOME="$fixture_root/agent-link" PATH="/usr/bin:/bin" \
  "$repo_root/agent-link" status)"
grep -q 'duplicated by a slot below' <<< "$status"

echo "authentication fixture passed"
