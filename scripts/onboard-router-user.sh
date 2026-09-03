#!/usr/bin/env bash
# Wire one Unix user's Claude Code and Codex CLIs to a shared 9router instance.
#
# Written for fleet-provisioned daemons: each user keeps their own CLI install
# and their own API key, but all of them route through one router process.
#
#   onboard-router-user.sh <user> [--router URL] [--codex-model ID] [--dry-run]
#
# The key is read from stdin so it never appears in argv, `ps`, or shell history:
#
#   printf '%s' "$KEY" | sudo ./onboard-router-user.sh alice
#
# Idempotent: re-running with the same key changes nothing. Existing settings are
# merged, never replaced, and every file it rewrites is backed up first.
set -euo pipefail

ROUTER_URL="http://127.0.0.1:20128"
CODEX_MODEL="cx/gpt-5.6-sol"
OPUS="cc/claude-opus-5"
SONNET="cc/claude-sonnet-5"
HAIKU="cc/claude-haiku-4-5-20251001"
DRY_RUN=0
TARGET_USER=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --router)       ROUTER_URL="${2:?--router needs a URL}"; shift 2 ;;
    --codex-model)  CODEX_MODEL="${2:?--codex-model needs an id}"; shift 2 ;;
    --opus)         OPUS="${2:?}"; shift 2 ;;
    --sonnet)       SONNET="${2:?}"; shift 2 ;;
    --haiku)        HAIKU="${2:?}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,14p' "$0"; exit 0 ;;
    -*)             die "unknown flag: $1" ;;
    *)              [ -n "$TARGET_USER" ] && die "only one user at a time"; TARGET_USER="$1"; shift ;;
  esac
done

[ -n "$TARGET_USER" ] || die "usage: printf '%s' \"\$KEY\" | $0 <user> [--router URL]"

# A bare model id makes the router look for a raw upstream provider that has no
# credentials attached, which surfaces as a confusing 404 rather than a config
# error. Routed ids always carry their pool prefix.
case "$CODEX_MODEL" in
  */*) ;;
  *) die "--codex-model must carry its pool prefix, e.g. cx/${CODEX_MODEL}" ;;
esac

HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6 || true)"
[ -n "$HOME_DIR" ] || die "no such user: $TARGET_USER"
[ -d "$HOME_DIR" ] || die "home directory does not exist: $HOME_DIR"

# Writing as root would land root-owned files in a home the daemon then cannot
# read, and 9router's own hijack resolves ~ with homedir() — as root that is
# /root, the wrong home entirely. So every write runs as the target user.
if [ "$(id -u)" -eq 0 ]; then
  RUN_AS=(sudo -u "$TARGET_USER" -H)
elif [ "$(id -un)" = "$TARGET_USER" ]; then
  RUN_AS=()
else
  die "run as root (to write another user's home) or as $TARGET_USER"
fi

API_KEY=""
if [ ! -t 0 ]; then IFS= read -r API_KEY || true; fi
API_KEY="${API_KEY//[$'\r\n\t ']/}"
[ -n "$API_KEY" ] || die "no API key on stdin — pipe it: printf '%s' \"\$KEY\" | $0 $TARGET_USER"

printf '\nOnboarding %s -> %s\n' "$TARGET_USER" "$ROUTER_URL"
note "home:        $HOME_DIR"
note "codex model: $CODEX_MODEL"
note "claude:      $OPUS / $SONNET / $HAIKU"
[ "$DRY_RUN" -eq 1 ] && note "MODE:        dry run, nothing will be written"

# Reachability is checked before anything is written: a config pointing at a
# dead router is worse than no config, because the failure surfaces later as an
# opaque 401 from the upstream vendor instead of a clear error here.
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${ROUTER_URL%/}/api/health" || echo 000)"
  [ "$code" = "200" ] || die "router not healthy at $ROUTER_URL (HTTP $code) — start it first"
  note "router:      healthy"
fi

export ONBOARD_KEY="$API_KEY" ONBOARD_URL="$ROUTER_URL" ONBOARD_CODEX_MODEL="$CODEX_MODEL" \
       ONBOARD_OPUS="$OPUS" ONBOARD_SONNET="$SONNET" ONBOARD_HAIKU="$HAIKU" ONBOARD_DRY="$DRY_RUN"

printf '\n'
"${RUN_AS[@]}" env \
  ONBOARD_KEY="$API_KEY" ONBOARD_URL="$ROUTER_URL" ONBOARD_CODEX_MODEL="$CODEX_MODEL" \
  ONBOARD_OPUS="$OPUS" ONBOARD_SONNET="$SONNET" ONBOARD_HAIKU="$HAIKU" ONBOARD_DRY="$DRY_RUN" \
  python3 - <<'PY'
import json, os, shutil, sys, time
from pathlib import Path

home  = Path.home()
key   = os.environ["ONBOARD_KEY"]
url   = os.environ["ONBOARD_URL"].rstrip("/")
model = os.environ["ONBOARD_CODEX_MODEL"]
dry   = os.environ["ONBOARD_DRY"] == "1"
stamp = time.strftime("%Y%m%d%H%M%S")
changed = []

def backup(path: Path) -> None:
    if path.exists():
        shutil.copy2(path, path.with_suffix(path.suffix + f".bak-onboard-{stamp}"))

def write(path: Path, text: str, mode: int) -> None:
    """Write via a temp file in the same directory so a crash cannot leave a
    half-written config where a working one used to be."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(path.suffix + ".tmp-onboard")
    tmp.write_text(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)

# ---------------------------------------------------------------- Claude
settings = home / ".claude" / "settings.json"
try:
    current = json.loads(settings.read_text()) if settings.exists() else {}
except json.JSONDecodeError:
    # Never clobber a file we cannot parse: a broken config is recoverable by
    # hand, an overwritten one is not.
    print("  claude: settings.json exists but is not valid JSON — left untouched", file=sys.stderr)
    current = None

if current is not None:
    env = dict(current.get("env") or {})
    desired = {
        "ANTHROPIC_BASE_URL": url,
        "ANTHROPIC_AUTH_TOKEN": key,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": os.environ["ONBOARD_OPUS"],
        "ANTHROPIC_DEFAULT_SONNET_MODEL": os.environ["ONBOARD_SONNET"],
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.environ["ONBOARD_HAIKU"],
    }
    if all(env.get(k) == v for k, v in desired.items()):
        print("  claude: already routed, unchanged")
    elif dry:
        print(f"  claude: WOULD set {sorted(k for k in desired if env.get(k) != desired[k])}")
    else:
        env.update(desired)
        # Everything else in the file — hooks, permissions, MCP — is preserved.
        current["env"] = env
        backup(settings)
        write(settings, json.dumps(current, indent=2) + "\n", 0o600)
        print("  claude: routed")
        changed.append(str(settings))

# ---------------------------------------------------------------- Codex
# Codex has no merge story for TOML here, so an existing file is reported rather
# than rewritten — it may carry MCP servers or provider blocks we did not author.
codex = home / ".codex" / "config.toml"
block = f'''model_provider = "9router"
model = "{model}"

[model_providers.9router]
name = "9Router"
base_url = "{url}/v1"
wire_api = "responses"

[model_providers.9router.http_headers]
Authorization = "Bearer {key}"
'''

if codex.exists():
    body = codex.read_text()
    if 'model_providers.9router' in body and f'model = "{model}"' in body:
        print("  codex:  already routed, unchanged")
    elif dry:
        print("  codex:  EXISTS and is not routed — needs manual merge (not overwritten)")
    else:
        print("  codex:  EXISTS and is not routed — NOT overwritten.")
        print(f"          Merge by hand, or move {codex} aside and re-run.")
elif dry:
    print(f"  codex:  WOULD create {codex}")
else:
    backup(codex)
    write(codex, block, 0o600)
    print("  codex:  routed")
    changed.append(str(codex))

# ---------------------------------------------------------------- diagnostics flag
# Claude Code sends a prompt-cache diagnostics field that a router cannot pass
# through to the upstream vendor. It is a cached feature flag, so a later fetch
# can re-enable it; this only fixes the current cache.
cj = home / ".claude.json"
if cj.exists():
    try:
        d = json.loads(cj.read_text())
        gb = d.setdefault("cachedGrowthBookFeatures", {})
        if gb.get("tengu_prompt_cache_diagnostics") is False:
            print("  flags:  diagnostics already off")
        elif dry:
            print("  flags:  WOULD disable tengu_prompt_cache_diagnostics")
        else:
            gb["tengu_prompt_cache_diagnostics"] = False
            backup(cj)
            write(cj, json.dumps(d, indent=2) + "\n", 0o600)
            print("  flags:  diagnostics disabled")
            changed.append(str(cj))
    except json.JSONDecodeError:
        print("  flags:  ~/.claude.json is not valid JSON — left untouched", file=sys.stderr)

if changed and not dry:
    print("\n  wrote:")
    for c in changed:
        print(f"    {c}  ({oct(os.stat(c).st_mode & 0o777)}, owner {Path(c).owner()})")
PY

printf '\nDone. New agents for %s will route through %s.\n' "$TARGET_USER" "$ROUTER_URL"
printf 'Sessions already running keep their old settings until restarted.\n\n'
