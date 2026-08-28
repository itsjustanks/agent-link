#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-refusal.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

account="test@example.com"
account_dir="$fixture_root/accounts/claude/$account"
mkdir -p "$account_dir/projects/fixture"
printf '%s\n' '{"oauthAccount":{"emailAddress":"test@example.com"}}' > "$account_dir/.claude.json"
printf '%s\n' '{"isApiErrorMessage":true,"message":"You'"'"'ve reached your Fable 5 limit."}' \
  > "$account_dir/projects/fixture/refusal.jsonl"

AGENT_LINK_HOME="$fixture_root" CLAUDE_CONFIG_DIR="$account_dir" \
  "$repo_root/agent-link" refused claude >/dev/null

test -f "$fixture_root/state/pools/holdmodel-claude-$account-fable-5"
test ! -f "$fixture_root/state/pools/hold-claude-$account"
test ! -f "$fixture_root/state/pools/cooldown-claude-$account"

# The model hold excludes this account only for Fable, not every Claude model.
test "$(HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" pick claude dry claude-fable-5 2>/dev/null || true)" != "$account"
test "$(HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" pick claude dry claude-sonnet-5 2>/dev/null)" = "$account"

# Paseo may omit --model on a resume. The launcher must recover it from the
# persisted agent record before choosing an account.
provider_bin="$fixture_root/provider-bin"
mkdir -p "$provider_bin" "$fixture_root/.paseo/agents/project"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "${CLAUDE_CONFIG_DIR:-primary}"' > "$provider_bin/claude"
chmod +x "$provider_bin/claude"
printf '%s\n' '{"persistence":{"metadata":{"model":"claude-fable-5"}},"metadata":{"model":"claude-fable-5"}}' \
  > "$fixture_root/.paseo/agents/project/agent-fable.json"
HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" auto >/dev/null
set +e
HOME="$fixture_root" PATH="$fixture_root/bin:$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  PASEO_AGENT_ID="agent-fable" "$fixture_root/bin/claude-auto" >/dev/null 2>&1
launch_rc=$?
set -e
test "$launch_rc" -eq 75

# A transport/auth/process failure is not proof that a held account recovered.
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
