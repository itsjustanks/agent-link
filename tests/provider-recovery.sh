#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-provider-recovery.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

failed_account="codex@example.com"
healthy_account="codex-backup@example.com"
for account in "$failed_account" "$healthy_account"; do
  mkdir -p "$fixture_root/accounts/codex/$account"
  printf '%s\n' '{}' > "$fixture_root/accounts/codex/$account/auth.json"
done

mkdir -p "$fixture_root/state/pools" "$fixture_root/.paseo/agents/project" "$fixture_root/provider-bin"
now_epoch="$(date +%s)"
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$now_epoch" codex "$failed_account" healthy standard agent-codex /tmp/project gpt-5.6-sol \
  > "$fixture_root/state/pools/routes.log"

printf '%s\n' \
  "{\"id\":\"agent-codex\",\"workspaceId\":\"workspace-1\",\"title\":\"Codex limited\",\"cwd\":\"/tmp/project\",\"provider\":\"codex-auto\",\"lastStatus\":\"error\",\"lastActivityAt\":\"$now_iso\",\"updatedAt\":\"$now_iso\",\"persistence\":{\"sessionId\":\"thread-codex\",\"metadata\":{\"model\":\"gpt-5.6-sol\"}}}" \
  > "$fixture_root/.paseo/agents/project/agent-codex.json"
printf '%s\n' \
  "{\"id\":\"agent-kimi\",\"workspaceId\":\"workspace-2\",\"title\":\"Kimi limited\",\"cwd\":\"/tmp/project\",\"provider\":\"kimi\",\"lastStatus\":\"error\",\"lastActivityAt\":\"$now_iso\",\"updatedAt\":\"$now_iso\",\"persistence\":{\"sessionId\":\"thread-kimi\",\"metadata\":{\"model\":\"kimi-k3\"}}}" \
  > "$fixture_root/.paseo/agents/project/agent-kimi.json"

send_log="$fixture_root/send.log"
printf '%s\n' '#!/usr/bin/env bash' \
  'case "$1" in' \
  '  ls) printf '\''[{"id":"agent-codex","name":"Codex limited","provider":"codex-auto/gpt-5.6-sol","status":"error","cwd":"/tmp/project"},{"id":"agent-kimi","name":"Kimi limited","provider":"kimi/kimi-k3","status":"error","cwd":"/tmp/project"}]'\'' ;;' \
  '  logs) if [ "$2" = agent-codex ]; then printf '\''[System Error] Usage limit reached\n'\''; else printf '\''[Provider Error] quota exceeded\n'\''; fi ;;' \
  '  inspect) printf '\''{"Status":"closed"}'\'' ;;' \
  '  send) printf '\''%s\n'\'' "$*" >> "$AGENT_LINK_TEST_SEND_LOG"; printf '\''{}'\'' ;;' \
  '  *) exit 2 ;;' \
  'esac' > "$fixture_root/provider-bin/paseo"
chmod +x "$fixture_root/provider-bin/paseo"

HOME="$fixture_root" PATH="$fixture_root/provider-bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_SEND_LOG="$send_log" "$repo_root/agent-link" recover --scan >/dev/null

test "$(wc -l < "$send_log" | tr -d ' ')" -eq 1
grep -q 'send agent-codex' "$send_log"
test -f "$fixture_root/state/pools/hold-codex-$failed_account"
test "$(find "$fixture_root/state/pools" -maxdepth 1 -name 'hold-kimi-*' | wc -l | tr -d ' ')" -eq 0

python3 - "$fixture_root/state/paseo-limit-sentry.json" "$fixture_root/state/paseo-recovery/scanner.json" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
events = {event["agentId"]: event for event in state["events"]}
assert events["agent-codex"]["action"] == "auto-resumed", events
assert events["agent-codex"]["account"] == "codex@example.com"
assert events["agent-codex"]["model"] == "gpt-5.6-sol"
assert "retry accepted by Paseo" in events["agent-codex"]["detail"]
assert events["agent-kimi"]["action"] == "needs-resume", events
assert "no alternate authenticated account route" in events["agent-kimi"]["detail"]
scanner = json.load(open(sys.argv[2]))
assert scanner["checked"] == 2, scanner
assert scanner["detected"] == 2, scanner
assert scanner["providers"] == ["codex-auto", "kimi"], scanner
PY

# The same terminal state is fingerprinted, so a second watchdog scan cannot
# send a duplicate continuation.
HOME="$fixture_root" PATH="$fixture_root/provider-bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_SEND_LOG="$send_log" "$repo_root/agent-link" recover --scan >/dev/null
test "$(wc -l < "$send_log" | tr -d ' ')" -eq 1

echo "provider recovery fixture passed"
