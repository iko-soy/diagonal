#!/usr/bin/env bash
# Pins the extension ID (section 14). Creates key.pem once (keep it out of the repo), writes the
# public key into manifest.json, the ID into ./extension-id and into host/grove-host.py's
# ALLOWED_ORIGIN, and prints the ID. Re-running with an existing key.pem changes nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f key.pem ]]; then
  openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out key.pem
  chmod 600 key.pem
  echo "created key.pem (private; not needed unless you pack a .crx)" >&2
fi

KEY=$(openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A)
ID=$(openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | od -An -tx1 | tr -d " \n" | head -c 32 | tr 0-9a-f a-p)

python3 - "$KEY" "$ID" <<'PY'
import json, re, sys
key, ext_id = sys.argv[1], sys.argv[2]
with open("manifest.json", encoding="utf-8") as f:
    m = json.load(f)
m["key"] = key
with open("manifest.json", "w", encoding="utf-8") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
p = "host/grove-host.py"
s = open(p, encoding="utf-8").read()
s = re.sub(r'^ALLOWED_ORIGIN = ".*"$', f'ALLOWED_ORIGIN = "chrome-extension://{ext_id}/"', s, count=1, flags=re.M)
open(p, "w", encoding="utf-8").write(s)
open("extension-id", "w").write(ext_id + "\n")
PY

echo "$ID"
