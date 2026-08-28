#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-refusal.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

account="test@example.com"
account_dir="$fixture_root/accounts/claude/$account"
mkdir -p "$account_dir/projects/fixture"
printf '%s\n' '{"isApiErrorMessage":true,"message":"You'"'"'ve reached your Fable 5 limit."}' \
  > "$account_dir/projects/fixture/refusal.jsonl"

AGENT_LINK_HOME="$fixture_root" CLAUDE_CONFIG_DIR="$account_dir" \
  "$repo_root/agent-link" refused claude >/dev/null

test -f "$fixture_root/state/pools/hold-claude-$account"
test ! -f "$fixture_root/state/pools/cooldown-claude-$account"
grep -q "awaiting successful probe" "$fixture_root/state/pools/reason-claude-$account"

# A transport/auth/process failure is not proof that a held account recovered.
mkdir -p "$fixture_root/bin"
printf '%s\n' '#!/usr/bin/env bash' 'echo "temporary probe failure" >&2' 'exit 42' \
  > "$fixture_root/bin/claude"
chmod +x "$fixture_root/bin/claude"
printf '%s\n' '{"oauthAccount":{"emailAddress":"primary@example.com"}}' > "$fixture_root/.claude.json"
printf '%s\n' 'prior limit refusal' > "$fixture_root/state/pools/hold-claude-primary"
probe_output="$(HOME="$fixture_root" PATH="$fixture_root/bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  "$repo_root/agent-link" probe claude claude-fable-5 --park)"
grep -q "CHECK FAILED" <<<"$probe_output"
test -f "$fixture_root/state/pools/hold-claude-primary"

echo "refusal routing fixture passed"
