#!/usr/bin/env bash
# Non-Nix installer for the native host (section 14).
#   scripts/install-manifest.sh [--beta] [--nightly] [--all-channels]
# The release zip ships this same script as install-host.command next to host/ and extension-id,
# so `bash install-host.command` works from the unzipped extension folder too.
# Copies host/ to ~/.local/share/diagonal-host, links ~/.local/bin/diagonal-host to it, writes the Brave
# host manifest with that absolute path and the pinned extension ID, then installs the fm schemas
# and runs the self-test. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$HERE/host" ]]; then cd "$HERE"; else cd "$HERE/.."; fi

CHANNELS=("Brave-Browser")
for arg in "$@"; do
  case "$arg" in
    --beta) CHANNELS+=("Brave-Browser-Beta") ;;
    --nightly) CHANNELS+=("Brave-Browser-Nightly") ;;
    --all-channels) CHANNELS=("Brave-Browser" "Brave-Browser-Beta" "Brave-Browser-Nightly") ;;
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

for ch in "${CHANNELS[@]}"; do
  DIR="$HOME/Library/Application Support/BraveSoftware/$ch/NativeMessagingHosts"
  mkdir -p "$DIR"
  "$BIN" --print-manifest "$BIN" > "$DIR/io.diagonal.host.json"
  echo "manifest: $DIR/io.diagonal.host.json"
done

echo "schemas:"
rc=0
"$BIN" --install-schemas || rc=$?
if [[ $rc -eq 3 ]]; then
  echo
  echo "One more step: accept Apple's terms for the fm tool once (asks for your password):"
  echo "  sudo fm license"
  echo "Diagonal finishes setting itself up the next time Brave talks to it."
  echo
elif [[ $rc -ne 0 ]]; then
  echo "  (schema install failed: is Apple Intelligence on? Details above.)"
fi
echo "self-test:"
"$BIN" --selftest || true
echo "extension ID: $ID"
