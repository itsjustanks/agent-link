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
  AGENT_LINK_ROUTE_MODEL="claude-fable-5" PASEO_AGENT_ID="agent-fable" \
  AGENT_LINK_SKIP_RECOVERY_KICKSTART=1 \
  "$repo_root/agent-link" refused claude >/dev/null

# A hard refusal creates one durable Paseo continuation request, including the
# exact account/model evidence. Repeated hooks for the same incident dedupe.
AGENT_LINK_HOME="$fixture_root" CLAUDE_CONFIG_DIR="$account_dir" \
  AGENT_LINK_ROUTE_MODEL="claude-fable-5" PASEO_AGENT_ID="agent-fable" \
  AGENT_LINK_SKIP_RECOVERY_KICKSTART=1 \
  "$repo_root/agent-link" refused claude >/dev/null
test "$(find "$fixture_root/state/paseo-recovery/pending" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 1
python3 - "$fixture_root/state/paseo-recovery/pending" <<'PY'
import glob, json, os, sys
request = json.load(open(glob.glob(os.path.join(sys.argv[1], "*.json"))[0]))
assert request["agentId"] == "agent-fable"
assert request["account"] == "test@example.com"
assert request["model"] == "claude-fable-5"
assert request["limit"] == "fable-5 limit"
PY

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

# The host-side recovery consumes the request once, accepts Paseo's closed
# state, and carries exact routing evidence into the continuation prompt.
send_log="$fixture_root/send.log"
printf '%s\n' '#!/usr/bin/env bash' \
  'case "$1" in' \
  '  inspect) printf '\''{"Status":"closed"}'\'' ;;' \
  '  send) printf '\''%s\n'\'' "$*" >> "$AGENT_LINK_TEST_SEND_LOG"; printf '\''{}'\'' ;;' \
  '  *) exit 2 ;;' \
  'esac' > "$provider_bin/paseo"
chmod +x "$provider_bin/paseo"
HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_SEND_LOG="$send_log" "$repo_root/agent-link" recover
test "$(wc -l < "$send_log" | tr -d ' ')" -eq 1
grep -q 'test@example.com hit fable-5 limit on claude-fable-5' "$send_log"
test "$(find "$fixture_root/state/paseo-recovery/pending" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 0
test "$(find "$fixture_root/state/paseo-recovery/done" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 1
grep -q '"outcome": "continuation-accepted"' "$fixture_root/state/paseo-recovery/done/"*.json
HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_SEND_LOG="$send_log" "$repo_root/agent-link" recover >/dev/null
test "$(wc -l < "$send_log" | tr -d ' ')" -eq 1

# Hook upgrades remove stale checkout/installed duplicates while preserving
# unrelated Claude hooks.
printf '%s\n' '{"hooks":{"StopFailure":[' \
  '{"matcher":"rate_limit","hooks":[{"type":"command","command":"/Users/ankit/.local/bin/agent-link refused claude"}]},' \
  '{"matcher":"billing_error","hooks":[{"type":"command","command":"/tmp/checkout/agent-link refused claude"}]},' \
  '{"matcher":"other","hooks":[{"type":"command","command":"keep-me"}]}' \
  ']}}' > "$account_dir/settings.json"
HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" hooks install >/dev/null
python3 - "$account_dir/settings.json" "$repo_root/agent-link" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
entries = settings["hooks"]["StopFailure"]
ours = [entry for entry in entries if "agent-link" in json.dumps(entry) and " refused claude" in json.dumps(entry)]
assert len(ours) == 1, ours
assert sys.argv[2] in json.dumps(ours[0])
assert any("keep-me" in json.dumps(entry) for entry in entries)
PY

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
