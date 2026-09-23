#!/usr/bin/env bash
# Non-Nix installer for the native host (section 14).
#   scripts/install-manifest.sh [--beta] [--nightly] [--all-channels]
# Copies host/ to ~/.local/share/diagonal-host, links ~/.local/bin/diagonal-host to it, writes the Brave
# host manifest with that absolute path and the pinned extension ID, then installs the fm schemas
# and runs the self-test. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

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
if [[ -z "$PYTHON" ]]; then
  echo "python3 not found on PATH" >&2
  exit 1
fi
# Brave starts the host with a minimal PATH, so the shebang names this python3 explicitly.
PYTHON=$("$PYTHON" -c 'import sys; print(sys.executable)')

SHARE="$HOME/.local/share/diagonal-host"
BIN="$HOME/.local/bin/diagonal-host"
mkdir -p "$SHARE" "$(dirname "$BIN")"
cp host/prompts.py host/validate.py host/emoji.txt "$SHARE/"
sed -e "1s|.*|#!$PYTHON|" -e "s|^ALLOWED_ORIGIN = \".*\"|ALLOWED_ORIGIN = \"chrome-extension://$ID/\"|" host/diagonal-host.py > "$SHARE/diagonal-host.py"
chmod 755 "$SHARE/diagonal-host.py"
ln -sf "$SHARE/diagonal-host.py" "$BIN"
echo "host:     $BIN -> $SHARE/diagonal-host.py"

for ch in "${CHANNELS[@]}"; do
  DIR="$HOME/Library/Application Support/BraveSoftware/$ch/NativeMessagingHosts"
  mkdir -p "$DIR"
  "$BIN" --print-manifest "$BIN" > "$DIR/io.diagonal.host.json"
  echo "manifest: $DIR/io.diagonal.host.json"
done

echo "schemas:"
"$BIN" --install-schemas || echo "  (schema install failed: is Apple Intelligence on and fm present?)"
echo "self-test:"
"$BIN" --selftest || true
echo "extension ID: $ID"
