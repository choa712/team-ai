#!/usr/bin/env bash
# One-command install for TeamAI on macOS and Linux: dependencies, build,
# command links, shell block. Windows uses scripts/install.cmd instead.
#
# Idempotent by design — re-running it upgrades an existing install rather than
# duplicating anything, so an agent can run it without first checking state.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_SHELL=ask
DRY_RUN=false
LAUNCHERS="tai taic tax tag"
# Where commands go when npm cannot link into its global prefix (EACCES on a
# root-owned /usr/local from the nodejs.org installer, for example).
USER_BIN="${TEAMAI_BIN_DIR:-$HOME/.local/bin}"

usage() {
  cat <<'USAGE'
Usage: install.sh [--no-shell] [--with-shell] [--dry-run]

  (default)      install, build, link, then ask about the shell block
  --with-shell   install the shell block without asking (for automation)
  --no-shell     skip the shell block entirely
  --dry-run      print what would happen, change nothing

When npm cannot link into its global prefix, the commands are linked into
~/.local/bin instead (override with TEAMAI_BIN_DIR); --with-shell then also
puts that directory on PATH.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-shell)   WITH_SHELL=no ;;
    --with-shell) WITH_SHELL=yes ;;
    --dry-run)    DRY_RUN=true ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n==> %s\n' "$1"; }
run()  { if [ "$DRY_RUN" = true ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

# Node 20 is the floor the code actually needs; failing here beats failing with
# a confusing syntax error somewhere inside the build.
step "Checking prerequisites"
command -v node >/dev/null || { echo "node not found. Install Node.js 20 or newer." >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm not found. Install Node.js 20 or newer." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node 20+ required, found $(node -v)." >&2; exit 1; }
echo "   node $(node -v)"

# Not fatal: TeamAI is useful with only one of the two clients installed, and a
# user may well be setting it up before installing the second.
command -v claude >/dev/null || echo "   note: 'claude' is not on PATH — Claude sessions will not launch until it is"
command -v codex  >/dev/null || echo "   note: 'codex' is not on PATH — Codex sessions will not launch until it is"

cd "$REPO_ROOT"

step "Installing dependencies"
# npm ci is reproducible, but it requires the lockfile to match package.json;
# fall back so a modified checkout still installs.
if [ -f package-lock.json ]; then run npm ci || run npm install; else run npm install; fi

step "Building"
run npm run build

step "Linking commands (teamai, ${LAUNCHERS// /, })"
LINKED_INTO=npm
# npm link writes into a global prefix that may need elevation. Rather than
# asking for sudo, fall back to a user-owned bin directory.
if ! run npm link; then
  echo "   npm link failed (usually a root-owned global prefix); linking into $USER_BIN instead"
  LINKED_INTO="$USER_BIN"
  run mkdir -p "$USER_BIN"
  run chmod +x "$REPO_ROOT/dist/src/cli.js"
  run ln -sf "$REPO_ROOT/dist/src/cli.js" "$USER_BIN/teamai"
  for name in $LAUNCHERS; do
    run chmod +x "$REPO_ROOT/dist/src/bin/$name.js"
    run ln -sf "$REPO_ROOT/dist/src/bin/$name.js" "$USER_BIN/$name"
  done
fi

if [ "$WITH_SHELL" = ask ] && [ -t 0 ]; then
  printf '\nAdd the cl/co/tai shell block to ~/.zshrc? [y/N] '
  read -r reply
  case "$reply" in [yY]*) WITH_SHELL=yes ;; *) WITH_SHELL=no ;; esac
elif [ "$WITH_SHELL" = ask ]; then
  # Non-interactive and undecided: do not touch the user's rc file silently.
  WITH_SHELL=no
fi

on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }
SHELL_ARGS=()
if [ "$LINKED_INTO" != npm ] && ! on_path "$USER_BIN"; then SHELL_ARGS+=(--path "$USER_BIN"); fi

if [ "$WITH_SHELL" = yes ]; then
  step "Installing shell block"
  if [ "$DRY_RUN" = true ]; then run "$REPO_ROOT/scripts/install-shell.sh" --dry-run ${SHELL_ARGS[@]+"${SHELL_ARGS[@]}"}; else "$REPO_ROOT/scripts/install-shell.sh" ${SHELL_ARGS[@]+"${SHELL_ARGS[@]}"}; fi
else
  step "Skipping shell block"
  echo "   run scripts/install-shell.sh later to add cl / co / tai"
  if [ ${#SHELL_ARGS[@]} -gt 0 ]; then echo "   $USER_BIN is not on PATH: add it, or re-run with --with-shell"; fi
fi

step "Verifying"
if [ "$DRY_RUN" = true ]; then
  echo "   would run: teamai help, and check that $LAUNCHERS resolve"
else
  # The fallback directory may not be on this shell's PATH yet.
  if [ "$LINKED_INTO" != npm ]; then PATH="$USER_BIN:$PATH"; fi
  for name in teamai $LAUNCHERS; do
    command -v "$name" >/dev/null || { echo "$name is not on PATH after linking. Check your npm prefix bin directory (npm prefix -g)." >&2; exit 1; }
  done
  teamai help >/dev/null
  echo "   teamai responds; $LAUNCHERS resolve to $(dirname "$(command -v teamai)")"
fi

# TeamClaude listened on the same Claude port (3456). A relay still running
# there makes every TeamAI start fail with "port in use", so say so now.
if [ "$DRY_RUN" != true ] && command -v lsof >/dev/null; then
  PORTS="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");const h=process.env.TEAMAI_HOME||p.join(process.env.XDG_CONFIG_HOME||p.join(os.homedir(),".config"),"teamai");let c={};try{c=JSON.parse(fs.readFileSync(p.join(h,"config.json"),"utf8")).proxy||{}}catch{}console.log([c.claudePort||3456,c.codexPort||3457].join(" "))')"
  for port in $PORTS; do
    owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fpc 2>/dev/null | awk '/^p/{pid=substr($0,2)} /^c/{print substr($0,2)" (pid "pid")"; exit}')"
    [ -n "$owner" ] || continue
    pid="${owner##*pid }"; pid="${pid%)}"
    if ps -o command= -p "$pid" 2>/dev/null | grep -qiE 'teamai|team-ai'; then continue; fi
    echo ""
    echo "   warning: port $port is already used by $owner."
    echo "   TeamAI cannot start while it is. If it is TeamClaude, stop it from another terminal: teamclaude stop"
  done
fi

cat <<DONE

TeamAI is installed. Next:

  teamai login     add a Claude or Codex account (repeat per account)
  taic             Claude Code through the account pool
  tax              Codex through the account pool
  tai              open the dashboard

DONE
