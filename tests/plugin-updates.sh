#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/paseo-home" "$test_dir/old-plugin" "$test_dir/agent-link-home"
printf '{"pluginsEnabled":true}\n' > "$test_dir/paseo-home/config.json"

cat > "$test_dir/bin/paseo" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PLUGIN_TEST_LOG"
case "$*" in
  "daemon status --json") printf '{"home":"%s"}\n' "$PLUGIN_TEST_PASEO_HOME" ;;
  "plugin add --help") printf '%s\n' '  --path <path>' ;;
  "plugin status agent-link --json") printf '[{"id":"agent-link","source":"%s"}]\n' "$PLUGIN_TEST_SOURCE" ;;
  "plugin ls --json") printf '[{"id":"agent-link","path":"%s"}]\n' "$PLUGIN_TEST_OLD_PATH" ;;
  "plugin ls") printf '%-20s %-12s\n' 'agent-link' 'running' ;;
esac
SH
chmod +x "$test_dir/bin/paseo"

run_install() {
  : > "$test_dir/calls.log"
  PLUGIN_TEST_LOG="$test_dir/calls.log" \
  PLUGIN_TEST_PASEO_HOME="$test_dir/paseo-home" \
  PLUGIN_TEST_OLD_PATH="$test_dir/old-plugin" \
  PLUGIN_TEST_SOURCE="$1" \
  AGENT_LINK_HOME="$test_dir/agent-link-home" \
  PATH="$test_dir/bin:$PATH" \
    "$repo_dir/agent-link" app install paseo >/dev/null
}

run_install directory
grep -Fq 'plugin remove agent-link' "$test_dir/calls.log"
grep -Fq 'plugin add itsjustanks/paseo-agent-link --path apps/paseo --id agent-link' "$test_dir/calls.log"

run_install git
grep -Fq 'plugin update agent-link' "$test_dir/calls.log"
if grep -Fq 'plugin remove agent-link' "$test_dir/calls.log"; then
  echo 'Git-managed update unexpectedly removed the plugin' >&2
  exit 1
fi

printf 'plugin update tests passed\n'
