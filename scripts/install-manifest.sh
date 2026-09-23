#!/usr/bin/env bash
# Non-Nix installer for the native host (section 14).
#   scripts/install-manifest.sh [--beta] [--nightly] [--all-channels]
# The release zip ships this same script as install-host.command next to host/ and extension-id,
# so `bash install-host.command` works from the unzipped extension folder too.
# Copies host/ to ~/.local/share/diagonal-host, links ~/.local/bin/diagonal-host to it, registers the host
# (absolute path, pinned extension ID) with every Chromium browser on this Mac, then installs the fm schemas
# and runs the self-test. Safe to re-run.
set -euo pipefail
# Keep a copy of this run's output for diagnosis (brew's own output scrolls away).
LOG_DIR="$HOME/Library/Logs/Diagonal"
if mkdir -p "$LOG_DIR" 2>/dev/null; then
  exec > >(tee "$LOG_DIR/install.log") 2>&1
  echo "$(date '+%Y-%m-%d %H:%M:%S') install-host from $0 (HOME=$HOME PATH=$PATH)"
fi
trap 'echo "Diagonal host install failed at line $LINENO: $BASH_COMMAND" >&2' ERR
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$HERE/host" ]]; then cd "$HERE"; else cd "$HERE/.."; fi

# (--beta, --nightly and --all-channels are accepted for old scripts; every browser is registered now.)
for arg in "$@"; do
  case "$arg" in
    --beta|--nightly|--all-channels) ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ID=$(tr -d '[:space:]' < extension-id 2>/dev/null || true)
if [[ -z "$ID" ]]; then
  echo "no ./extension-id: run scripts/gen-key.sh first" >&2
  exit 1
fi

PYTHON=$(command -v python3 || true)
# Brave starts the host with a minimal PATH, so the shebang names this python3 explicitly.
# On a Mac without the Command Line Tools, /usr/bin/python3 is a stub that only offers to install them.
if [[ -z "$PYTHON" ]] || ! PYTHON=$("$PYTHON" -c 'import sys; print(sys.executable)' 2>/dev/null); then
  echo "python3 is not set up. Run: xcode-select --install   then run this installer again." >&2
  exit 1
fi

SHARE="$HOME/.local/share/diagonal-host"
BIN="$HOME/.local/bin/diagonal-host"
mkdir -p "$SHARE" "$(dirname "$BIN")"
cp host/prompts.py host/validate.py host/emoji.txt "$SHARE/"
sed -e "1s|.*|#!$PYTHON|" -e "s|^ALLOWED_ORIGIN = \".*\"|ALLOWED_ORIGIN = \"chrome-extension://$ID/\"|" host/diagonal-host.py > "$SHARE/diagonal-host.py"
chmod 755 "$SHARE/diagonal-host.py"
# Files unzipped from a browser download carry the quarantine flag; the host must not.
xattr -dr com.apple.quarantine "$SHARE" 2>/dev/null || true
ln -sf "$SHARE/diagonal-host.py" "$BIN"
echo "host:     $BIN -> $SHARE/diagonal-host.py"

"$BIN" --version >/dev/null  # the host must start with the python3 it was pinned to
# Writes the manifest into every Chromium browser's NativeMessagingHosts folder (Chrome, Brave and
# Brave Origin, Edge, Vivaldi, Arc, Opera, …) and checks each one the way the browser reads it.
"$BIN" --register "$BIN"

FM="${DIAGONAL_FM:-/usr/bin/fm}"

# fm refuses to run (exit 69) until someone accepts Apple's terms for it, once per Mac.
needs_license() {
  local out rc=0
  out=$("$FM" available --model system 2>&1) || rc=$?
  [[ $rc -eq 69 ]] || grep -qiE "legal notice|fm license" <<<"$out"
}

echo
if [[ ! -x "$FM" ]]; then
  echo "Diagonal's host is installed, but $FM is missing: Diagonal needs macOS 27 with Apple Intelligence."
  exit 0
fi

if needs_license; then
  echo "Diagonal names tabs with Apple's on-device model through the fm tool, which asks you to accept"
  echo "Apple's terms once per Mac. The choice applies to every user here, so sudo asks for your password."
  # Only with a terminal to read the terms and answer in; brew and double-click installs have one.
  if [[ -z "${DIAGONAL_NO_PROMPT:-}" ]] && { : </dev/tty; } 2>/dev/null; then
    ${DIAGONAL_SUDO-sudo} "$FM" license </dev/tty >/dev/tty 2>&1 || true
    echo
  fi
  if needs_license; then
    echo
    echo "Diagonal is installed, but it can't name tabs until Apple's terms for fm are accepted."
    echo "When you're ready, run: sudo fm license"
    exit 0
  fi
fi

# Diagonal also writes these on first use; doing it now lets the self-test below cover the model.
schemas_out=$("$BIN" --install-schemas 2>&1) || true
if selftest_out=$("$BIN" --selftest 2>&1); then
  echo "Diagonal's host is ready."
else
  echo "Diagonal's host is installed, but its self-test found a problem:"
  echo "$schemas_out"
  echo "$selftest_out"
fi
