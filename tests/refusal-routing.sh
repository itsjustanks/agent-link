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
  AGENT_LINK_TEST_SEND_LOG="$send_log" "$repo_root/agent-link" recover >/dev/null
test ! -e "$send_log"
test "$(find "$fixture_root/state/paseo-recovery/pending" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 1
grep -q 'waiting for a healthy alternate account' "$fixture_root/state/paseo-recovery/pending/"*.json

# A queued retry waits instead of hammering the exhausted account, then runs
# once a genuinely healthy alternate joins the pool.
healthy_account="healthy@example.com"
mkdir -p "$fixture_root/accounts/claude/$healthy_account"
printf '%s\n' '{"oauthAccount":{"emailAddress":"healthy@example.com"}}' \
  > "$fixture_root/accounts/claude/$healthy_account/.claude.json"
python3 - "$fixture_root/state/paseo-recovery/pending" <<'PY'
import glob, json, os, sys
path = glob.glob(os.path.join(sys.argv[1], "*.json"))[0]
request = json.load(open(path))
request["notBefore"] = 0
json.dump(request, open(path, "w"))
PY
HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_SEND_LOG="$send_log" "$repo_root/agent-link" recover >/dev/null
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
test ! -f "$fixture_root/state/pools/holdmodel-claude-primary-fable-5"

# Codex holds are re-proved too. A failed CLI call preserves the hold; a real
# successful `codex exec` releases it without waiting for a manual clear.
mkdir -p "$fixture_root/.codex"
python3 - "$fixture_root/.codex/auth.json" <<'PY'
import base64, json, sys
payload = base64.urlsafe_b64encode(json.dumps({"email": "codex-primary@example.com"}).encode()).decode().rstrip("=")
json.dump({"tokens": {"id_token": f"x.{payload}.x"}}, open(sys.argv[1], "w"))
PY
codex_fail="$fixture_root/codex-probe-fail"
codex_log="$fixture_root/codex-probe.log"
touch "$codex_fail"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf '\''%s\n'\'' "$*" >> "$AGENT_LINK_TEST_CODEX_LOG"' \
  'if [ -f "$AGENT_LINK_TEST_CODEX_FAIL" ]; then echo "temporary probe failure" >&2; exit 42; fi' \
  'echo ok' > "$provider_bin/codex"
chmod +x "$provider_bin/codex"
printf '%s\n' 'prior limit refusal' > "$fixture_root/state/pools/hold-codex-primary"
probe_output="$(HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_CODEX_FAIL="$codex_fail" AGENT_LINK_TEST_CODEX_LOG="$codex_log" \
  "$repo_root/agent-link" probe codex gpt-5.6-sol --park)"
grep -q "CHECK FAILED" <<<"$probe_output"
test -f "$fixture_root/state/pools/hold-codex-primary"
rm "$codex_fail"
HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_CODEX_FAIL="$codex_fail" AGENT_LINK_TEST_CODEX_LOG="$codex_log" \
  "$repo_root/agent-link" revalidate codex >/dev/null
test ! -f "$fixture_root/state/pools/hold-codex-primary"
grep -q 'exec --skip-git-repo-check --ephemeral --color never' "$codex_log"

# A proven revoked login is account-wide, not model-specific. Fail closed so
# every Claude model skips that config directory until interactive sign-in.
printf '%s\n' '#!/usr/bin/env bash' \
  'echo "Failed to authenticate. API Error: 401 OAuth access token has been revoked." >&2' \
  'exit 1' > "$fixture_root/bin/claude"
chmod +x "$fixture_root/bin/claude"
probe_output="$(HOME="$fixture_root" PATH="$fixture_root/bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  "$repo_root/agent-link" probe claude claude-opus-5 --park)"
grep -q "AUTH FAILED" <<<"$probe_output"
grep -q "authentication failed" "$fixture_root/state/pools/hold-claude-primary"
grep -q "authentication failed" "$fixture_root/state/pools/hold-claude-$account"
test ! -f "$fixture_root/state/pools/holdmodel-claude-primary-opus-5"
status_output="$(HOME="$fixture_root" PATH="$fixture_root/bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  "$repo_root/agent-link" status)"
grep -q "primary.*HELD.*authentication failed" <<<"$status_output"
grep -q "$account.*held.*authentication failed" <<<"$status_output"

# `login all` includes primary Claude now, and an explicit successful login
# clears only the authentication hold (model-specific holds remain separate).
auth_state="$fixture_root/auth-state"
mkdir -p "$auth_state"
printf '%s\n' '#!/usr/bin/env bash' \
  'key=primary' \
  'if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then key="$(basename "$CLAUDE_CONFIG_DIR")"; fi' \
  'case "$1 $2" in' \
  '  "auth status") if [ -f "$AGENT_LINK_TEST_AUTH_STATE/$key" ]; then printf '\''{"loggedIn":true}'\''; else printf '\''{"loggedIn":false}'\''; fi ;;' \
  '  "auth login") mkdir -p "$AGENT_LINK_TEST_AUTH_STATE"; touch "$AGENT_LINK_TEST_AUTH_STATE/$key" ;;' \
  '  *) exit 2 ;;' \
  'esac' > "$provider_bin/claude"
chmod +x "$provider_bin/claude"
HOME="$fixture_root" PATH="$provider_bin:$fixture_root/bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_AUTH_STATE="$auth_state" "$repo_root/agent-link" login claude primary >/dev/null
test ! -f "$fixture_root/state/pools/hold-claude-primary"
HOME="$fixture_root" PATH="$provider_bin:$fixture_root/bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_AUTH_STATE="$auth_state" "$repo_root/agent-link" login claude "$account" >/dev/null
test ! -f "$fixture_root/state/pools/hold-claude-$account"

echo "refusal routing fixture passed"
