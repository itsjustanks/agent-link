#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-cross-provider.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

claude_account="claude@example.com"
claude_dir="$fixture_root/accounts/claude/$claude_account"
codex_account="codex@example.com"
codex_dir="$fixture_root/accounts/codex/$codex_account"
mkdir -p "$claude_dir/projects/fixture" "$codex_dir" "$fixture_root/.paseo/agents/project"
printf '%s\n' '{"oauthAccount":{"emailAddress":"claude@example.com"}}' > "$claude_dir/.claude.json"
printf '%s\n' '{"isApiErrorMessage":true,"message":"You have reached your Fable 5 limit."}' > "$claude_dir/projects/fixture/refusal.jsonl"
python3 - "$codex_dir/auth.json" <<'PY'
import base64, json, sys
payload = base64.urlsafe_b64encode(json.dumps({"email": "codex@example.com"}).encode()).decode().rstrip("=")
json.dump({"tokens": {"id_token": f"x.{payload}.x"}}, open(sys.argv[1], "w"))
PY
printf '%s\n' '{"workspaceId":"workspace-1","title":"Interrupted build","cwd":"/tmp/project","labels":{"paseo.open-agent-tab.client-1":"true"},"persistence":{"metadata":{"model":"claude-fable-5"}}}' \
  > "$fixture_root/.paseo/agents/project/agent-source.json"
printf '%s\n' '{"id":"child-live","workspaceId":"workspace-1","title":"Live child","status":"running","labels":{"paseo.parent-agent-id":"agent-source","track":"implementation"}}' \
  > "$fixture_root/.paseo/agents/project/child-live.json"
printf '%s\n' '{"id":"child-archived","workspaceId":"workspace-1","title":"Archived child","status":"closed","archivedAt":"2026-01-01T00:00:00Z","labels":{"paseo.parent-agent-id":"agent-source"}}' \
  > "$fixture_root/.paseo/agents/project/child-archived.json"
printf '%s\n' '{"fallbacks":{"claude/claude-fable-5":["claude-auto/claude-fable-5","codex/gpt-5.6-sol"]}}' \
  > "$fixture_root/.paseo/orchestration-preferences.json"

HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" CLAUDE_CONFIG_DIR="$claude_dir" \
  AGENT_LINK_ROUTE_MODEL="claude-fable-5" PASEO_AGENT_ID="agent-source" \
  AGENT_LINK_SKIP_RECOVERY_KICKSTART=1 "$repo_root/agent-link" refused claude >/dev/null

provider_bin="$fixture_root/provider-bin"
run_log="$fixture_root/run.log"
update_log="$fixture_root/update.log"
reload_log="$fixture_root/reload.log"
mkdir -p "$provider_bin"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "$1" = inspect ]; then [ -f "$AGENT_LINK_TEST_INSPECT_FAIL" ] && exit 2; printf '\''{"Status":"closed","Name":"Interrupted build","Cwd":"/tmp/project"}'\''; exit 0; fi' \
  'if [ "$1 $2" = "agent ls" ]; then printf '\''[{"id":"child-live","status":"running","labels":{"paseo.parent-agent-id":"agent-source"}},{"id":"child-archived","status":"closed","archivedAt":"2026-01-01T00:00:00Z","labels":{"paseo.parent-agent-id":"agent-source"}}]'\''; exit 0; fi' \
  'if [ "$1 $2" = "agent run" ]; then printf '\''%s\n'\'' "$*" >> "$AGENT_LINK_TEST_RUN_LOG"; printf '\''{"id":"agent-sol"}'\''; exit 0; fi' \
  'if [ "$1 $2" = "agent update" ]; then printf '\''%s\n'\'' "$*" >> "$AGENT_LINK_TEST_UPDATE_LOG"; printf '\''{}'\''; exit 0; fi' \
  'if [ "$1 $2" = "agent reload" ]; then printf '\''%s\n'\'' "$*" >> "$AGENT_LINK_TEST_RELOAD_LOG"; python3 - "$AGENT_LINK_TEST_TARGET_RECORD" <<'\''PY'\''' \
  'import json, sys' \
  'path = sys.argv[1]' \
  'record = json.load(open(path))' \
  'record["archivedAt"] = None' \
  'json.dump(record, open(path, "w"))' \
  'PY' \
  'printf '\''{}'\''; exit 0; fi' \
  'if [ "$1 $2" = "agent detach" ]; then exit 0; fi' \
  'exit 2' > "$provider_bin/paseo"
chmod +x "$provider_bin/paseo"

HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_RUN_LOG="$run_log" AGENT_LINK_TEST_UPDATE_LOG="$update_log" \
  AGENT_LINK_TEST_RELOAD_LOG="$reload_log" AGENT_LINK_TEST_TARGET_RECORD="$fixture_root/.paseo/agents/project/agent-sol.json" \
  AGENT_LINK_TEST_INSPECT_FAIL="$fixture_root/inspect-fail" "$repo_root/agent-link" recover >/dev/null

test "$(wc -l < "$run_log" | tr -d ' ')" -eq 1
grep -q -- '--provider codex-auto/gpt-5.6-sol' "$run_log"
grep -q -- '--thinking ultra' "$run_log"
grep -q -- '--workspace workspace-1' "$run_log" || { printf 'missing workspace in: '; cat "$run_log"; exit 1; }
grep -q -- '--label agent-link-continuation-of=agent-source' "$run_log"
grep -q -- '--label agent-link-continuation-root=agent-source' "$run_log"
grep -q -- '--label paseo.open-agent-tab.client-1=true' "$run_log"
grep -q -- '--title Interrupted build' "$run_log"
grep -q -- 'agent update child-live .*--label paseo.parent-agent-id=agent-sol' "$update_log"
grep -q -- 'agent update child-live .*--label agent-link-continuation-root=agent-source' "$update_log"
grep -q -- 'agent update agent-source .*--label paseo.parent-agent-id=agent-sol' "$update_log"
grep -q -- 'agent update agent-source .*--label agent-link-superseded-by=agent-sol' "$update_log"
grep -q -- 'agent update agent-source .*--label paseo.open-agent-tab.client-1=false' "$update_log"
! grep -q 'child-archived' "$update_log"
test "$(find "$fixture_root/state/paseo-recovery/pending" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 0
done_file="$(find "$fixture_root/state/paseo-recovery/done" -type f -name '*.json' -print -quit)"
grep -q '"outcome": "cross-provider-continuation"' "$done_file"
grep -q '"targetAgentId": "agent-sol"' "$done_file"
grep -q '"logicalRootAgentId": "agent-source"' "$done_file"
grep -q '"carriedChildAgentIds": \["child-live"\]' "$done_file"
grep -q '"targetProvider": "codex-auto"' "$fixture_root/state/paseo-limit-sentry.json"

# A duplicate refusal for the same source links to the existing continuation
# instead of starting another agent. If only that current continuation was
# archived, it is reloaded and reused rather than replaced by a third tab.
printf '%s\n' '{"id":"agent-sol","archivedAt":"2026-01-01T00:00:00Z","labels":{"agent-link-continuation-root":"agent-source","agent-link-continuation-current":"true"}}' \
  > "$fixture_root/.paseo/agents/project/agent-sol.json"
python3 - "$done_file" "$fixture_root/state/paseo-recovery/pending/agent-source-duplicate.json" <<'PY'
import json, sys, time
request = json.load(open(sys.argv[1]))
request.pop("completedAt", None)
request.pop("outcome", None)
request["createdAt"] = time.time()
request["notBefore"] = 0
json.dump(request, open(sys.argv[2], "w"))
PY
touch "$fixture_root/inspect-fail"
HOME="$fixture_root" PATH="$provider_bin:$PATH" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_RUN_LOG="$run_log" AGENT_LINK_TEST_UPDATE_LOG="$update_log" \
  AGENT_LINK_TEST_RELOAD_LOG="$reload_log" AGENT_LINK_TEST_TARGET_RECORD="$fixture_root/.paseo/agents/project/agent-sol.json" \
  AGENT_LINK_TEST_INSPECT_FAIL="$fixture_root/inspect-fail" "$repo_root/agent-link" recover >/dev/null
test "$(wc -l < "$run_log" | tr -d ' ')" -eq 1
test "$(wc -l < "$reload_log" | tr -d ' ')" -eq 1
grep -q 'agent reload agent-sol --json' "$reload_log"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("archivedAt"))' "$fixture_root/.paseo/agents/project/agent-sol.json")" = None
grep -q '"outcome": "already-cross-provider"' "$fixture_root/state/paseo-recovery/done/agent-source-duplicate.json"

echo "cross-provider recovery fixture passed"
