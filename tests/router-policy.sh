#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-router.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$fixture_root/router"
cat > "$fixture_root/router/rules.md" <<'EOF'
# AgentRouter rules — edit freely; read at every launch.
## Stay on the base (cheap) model for
- triage
## Delegate
- long autonomous builds, wide refactors
EOF

AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" router install >/dev/null

test -x "$fixture_root/bin/agent-router"
grep -q 'codex-auto/gpt-5.6-luna' "$fixture_root/router/policy.md"
grep -q 'kimi/kimi-code/k3' "$fixture_root/router/policy.md"
grep -q 'grok/grok-4.6' "$fixture_root/router/policy.md"
grep -q "use Claude's built-in Agent/Task" "$fixture_root/router/prompt.md"
grep -q 'call Paseo `inspect_provider`' "$fixture_root/router/prompt.md"
grep -q 'AgentRouter · <exact provider/model> ·' "$fixture_root/router/prompt.md"
grep -q 'MANAGED TARGET POLICY' "$fixture_root/router/system.md"
grep -q 'if the user names a provider or model, use exactly that' "$fixture_root/router/rules.md"
! grep -q 'Stay on the base (cheap) model' "$fixture_root/router/rules.md"
grep -q '"controllerModel": "claude-fable-5"' "$fixture_root/router/config.json"

python3 - "$fixture_root/router/config.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["controllerProvider"] = "claude"
data["controllerModel"] = "claude-opus-5"
data["targetGroups"] = [{
    "name": "research",
    "purpose": "Provider-agnostic research",
    "targets": [{"provider": "gemini", "model": "gemini-3-pro"}],
}]
json.dump(data, open(path, "w"), indent=2)
PY
AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" router install >/dev/null
grep -q 'gemini/gemini-3-pro' "$fixture_root/router/policy.md"
grep -q 'controllerProvider' "$fixture_root/bin/agent-router"

printf '%s\n' '# keep my custom routing rule' > "$fixture_root/router/rules.md"
AGENT_LINK_HOME="$fixture_root" "$repo_root/agent-link" router install >/dev/null
grep -q 'keep my custom routing rule' "$fixture_root/router/rules.md"

echo "router policy fixture passed"
