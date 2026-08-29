#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /private/tmp/agent-link-toolchain.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$fixture_root/provider-bin" "$fixture_root/Library/LaunchAgents"
update_log="$fixture_root/updates.log"

for provider in claude codex kimi grok; do
  cat > "$fixture_root/provider-bin/$provider" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = --version ]; then echo "$provider 1.0"; exit 0; fi
echo "$provider \$*" >> "$update_log"
EOF
  chmod +x "$fixture_root/provider-bin/$provider"
done

cat > "$fixture_root/provider-bin/paseo" <<'EOF'
#!/usr/bin/env bash
if [ "${PASEO_UNAVAILABLE:-}" = 1 ]; then exit 2; fi
if [ "${1:-}" = --version ]; then echo "paseo 1.0"; exit 0; fi
printf '[{"provider":"claude-auto/claude-opus-5","status":"running"}]'
EOF
cat > "$fixture_root/provider-bin/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "$fixture_root/provider-bin/curl" <<'EOF'
#!/usr/bin/env bash
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; output="$1"; fi
  shift
done
cat > "$output" <<'SCRIPT'
#!/usr/bin/env bash
echo "kimi installer" >> "$AGENT_LINK_TEST_UPDATE_LOG"
SCRIPT
EOF
cat > "$fixture_root/provider-bin/launchctl" <<EOF
#!/usr/bin/env bash
echo "launchctl \$*" >> "$fixture_root/launchctl.log"
EOF
chmod +x "$fixture_root/provider-bin/"*

PATH="$fixture_root/provider-bin:/usr/bin:/bin" HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_UPDATE_LOG="$update_log" "$repo_root/agent-link" toolchain update >/dev/null

if grep -q '^claude update' "$update_log"; then
  echo "live Claude binary was updated" >&2
  exit 1
fi
grep -q '^codex update' "$update_log"
grep -q '^grok update --stable' "$update_log"
grep -q '^kimi installer' "$update_log"

: > "$update_log"
PATH="$fixture_root/provider-bin:/usr/bin:/bin" HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" \
  AGENT_LINK_TEST_UPDATE_LOG="$update_log" PASEO_UNAVAILABLE=1 \
  "$repo_root/agent-link" toolchain update >/dev/null
test ! -s "$update_log"

PATH="$fixture_root/provider-bin:/usr/bin:/bin" HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" \
  "$repo_root/agent-link" toolchain enable >/dev/null
python3 - "$fixture_root/Library/LaunchAgents/com.agent-link.toolchain-updater.plist" <<'PY'
import plistlib, sys
data = plistlib.load(open(sys.argv[1], "rb"))
assert data["Label"] == "com.agent-link.toolchain-updater"
assert data["ProgramArguments"][1:] == ["toolchain", "update", "--scheduled"]
assert data["StartCalendarInterval"] == {"Hour": 4, "Minute": 15}
assert data["LowPriorityIO"] is True
assert data["Nice"] == 10
PY
grep -q '^launchctl bootstrap ' "$fixture_root/launchctl.log"

PATH="$fixture_root/provider-bin:/usr/bin:/bin" HOME="$fixture_root" AGENT_LINK_HOME="$fixture_root" \
  "$repo_root/agent-link" toolchain disable >/dev/null
test ! -e "$fixture_root/Library/LaunchAgents/com.agent-link.toolchain-updater.plist"

echo "toolchain updater fixture passed"
