#!/usr/bin/env python3
"""grove-host: Brave native-messaging host that calls /usr/bin/fm once and exits.

Protocol (section 8): Brave starts this process with the caller's origin as argv[1], writes one
length-prefixed JSON request to stdin, and reads one length-prefixed JSON reply from stdout.
Standard library only; no network imports.

Other entry points:
  grove-host --selftest          check fm, the model, the schemas, and one fixture naming call
  grove-host --install-schemas   write the fm schema files to ~/Library/Application Support/Grove/schemas
  grove-host --print-manifest P  print the host manifest JSON for executable path P
  grove-host --version
"""
import json
import os
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

import prompts  # noqa: E402
import validate  # noqa: E402

HOST_VERSION = "0.1.0"
HOST_NAME = "io.grove.host"
ALLOWED_ORIGIN = "chrome-extension://mpnodlalikgeehnlnofdkpgapkmbkjdf/"
FM = os.environ.get("GROVE_FM", "/usr/bin/fm")  # tests point this at host/tests/fake_fm.py
SUPPORT = os.environ.get("GROVE_SUPPORT_DIR", os.path.expanduser("~/Library/Application Support/Grove"))
SCHEMAS = os.path.join(SUPPORT, "schemas")
LOG_DIR = os.environ.get("GROVE_LOG_DIR", os.path.expanduser("~/Library/Logs/Grove"))
LOG_MAX_BYTES = 5 * 1024 * 1024
CHAR_BUDGET = 10_000  # ≈ 2,850 tokens of prompt at 3.5 chars/token (section 9); double once 8,192 is confirmed
MAX_REQUEST = 64 * 1024 * 1024
MAX_REPLY = 1024 * 1024
OPS = {"ping", "name", "organize"}

# `fm schema` argument lists (section 8). The nested form is unverified on a real macOS 27 machine;
# when it fails, --install-schemas writes the two flat schemas and `organize` takes two calls.
SCHEMA_COMMANDS = {
    "name.json": ["schema", "object", "--name", "GroupName", "--string", "title", "--string", "emoji"],
    "organize.json": ["schema", "object", "--name", "Organized",
                      "--object", "groups", "--array",
                      "--string", "title", "--string", "emoji", "--string", "color",
                      "--integer", "existing", "--integer", "members", "--array",
                      "--integer", "leftovers", "--array"],
}
FALLBACK_SCHEMA_COMMANDS = {
    "organize-labels.json": ["schema", "object", "--name", "TopicLabels",
                             "--string", "labels", "--array", "--string", "emojis", "--array", "--string", "colors", "--array"],
    "organize-assign.json": ["schema", "object", "--name", "Assignment", "--integer", "assignment", "--array"],
}


class Fail(Exception):
    def __init__(self, code, message, retryable=False, raw=None, **extra):
        super().__init__(message)
        self.code, self.message, self.retryable, self.raw, self.extra = code, message, retryable, raw, extra


# ----- framing ------------------------------------------------------------------------------------

def read_frame(stream=None):
    stream = stream or sys.stdin.buffer
    head = stream.read(4)
    if len(head) < 4:
        return None  # Brave closed the pipe before sending: nothing to answer
    (n,) = struct.unpack("<I", head)
    if n > MAX_REQUEST:
        raise Fail("BAD_REQUEST", f"frame of {n} bytes exceeds 64 MiB")
    body = stream.read(n)
    if len(body) < n:
        raise Fail("BAD_REQUEST", "truncated frame")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Fail("BAD_REQUEST", f"request is not UTF-8 JSON: {e}")


def encode_frame(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_REPLY:
        err = obj.get("error") or {}
        obj = {"v": 1, "id": obj.get("id"), "ok": False,
               "error": {"code": "BAD_MODEL_OUTPUT", "message": "reply exceeded 1 MB", "retryable": False,
                         "raw": str(err.get("raw", ""))[:1000]}}
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def write_frame(obj, stream=None):
    stream = stream or sys.stdout.buffer
    stream.write(encode_frame(obj))
    stream.flush()


def error_reply(rid, f):
    err = {"code": f.code, "message": f.message, "retryable": f.retryable, "raw": f.raw}
    err.update(f.extra)
    return {"v": 1, "id": rid, "ok": False, "error": err}


# ----- request validation ------------------------------------------------------------------------

def _trim(s, n):
    return s[:n] if isinstance(s, str) else ""


def validate_request(req):
    if not isinstance(req, dict) or req.get("v") != 1:
        raise Fail("BAD_REQUEST", "envelope must be an object with v: 1")
    if req.get("op") not in OPS:
        raise Fail("BAD_REQUEST", f"unknown op {req.get('op')!r}")
    rid = req.get("id")
    if rid is not None and (not isinstance(rid, str) or len(rid) > 100):
        raise Fail("BAD_REQUEST", "id must be a short string")
    payload = req.get("payload", {})
    opts = req.get("opts", {})
    if not isinstance(payload, dict) or not isinstance(opts, dict):
        raise Fail("BAD_REQUEST", "payload and opts must be objects")
    if req["op"] in ("name", "organize"):
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise Fail("BAD_REQUEST", "payload.items must be a non-empty list")
        clean = []
        for n, it in enumerate(items):
            if not isinstance(it, dict):
                raise Fail("BAD_REQUEST", f"item {n} is not an object")
            clean.append({"i": n, "title": _trim(it.get("title"), 120), "url": _trim(it.get("url"), 300),
                          "description": _trim(it.get("description"), 300)})
        payload["items"] = clean
        for key in ("siblingTitles", "mustDifferFrom"):
            payload[key] = [_trim(t, 60) for t in payload.get(key) or [] if isinstance(t, str)][:20]
        if "currentTitle" in payload:
            payload["currentTitle"] = _trim(payload["currentTitle"], 60)
        groups = payload.get("existingGroups") or []
        if not isinstance(groups, list):
            raise Fail("BAD_REQUEST", "existingGroups must be a list")
        payload["existingGroups"] = [
            {"g": n, "title": _trim(g.get("title"), 60), "samples": [_trim(s, 60) for s in (g.get("samples") or [])[:2]]}
            for n, g in enumerate(groups[:12]) if isinstance(g, dict)
        ]
    model = opts.get("model", "system")
    if model not in ("system", "pcc"):
        raise Fail("BAD_REQUEST", "opts.model must be system or pcc")
    return req


# ----- fm ---------------------------------------------------------------------------------------

def classify(stderr):
    s = (stderr or "").lower()
    if "not available" in s or "unavailable" in s or "apple intelligence" in s or "download" in s or "not supported" in s:
        return "MODEL_UNAVAILABLE"
    if "rate" in s and "limit" in s:
        return "RATE_LIMITED"
    if "context" in s or "too long" in s or "exceed" in s:
        return "OVER_BUDGET"
    if "guardrail" in s or "safety" in s or "unsafe" in s:
        return "GUARDRAIL"
    return "FM_ERROR"


def fm_env():
    return {"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", ""), "LANG": "en_US.UTF-8"}


def schema_path(name):
    path = os.path.join(SCHEMAS, name)
    return path if os.path.isfile(path) and os.path.getsize(path) > 0 else None


def check_budget(prompt, n_items):
    if len(prompt) > CHAR_BUDGET:
        allowed = max(1, int(n_items * CHAR_BUDGET / len(prompt)))
        raise Fail("OVER_BUDGET", f"prompt is {len(prompt)} chars, budget {CHAR_BUDGET}", retryable=True, allowedItems=allowed)


def extract_json(stdout):
    """fm should print bare JSON under --schema; tolerate prose or a code fence around it."""
    text = (stdout or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    while start != -1:
        try:
            obj, _ = json.JSONDecoder().raw_decode(text[start:])
            return obj
        except json.JSONDecodeError:
            start = text.find("{", start + 1)
    raise Fail("BAD_MODEL_OUTPUT", "no JSON object in fm output", raw=text[:2000])


def run_fm(prompt, schema, model, timeout_s):
    args = [FM, "respond", "--model", model, "--no-stream", "--schema", schema, "--", prompt]
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout_s, env=fm_env())
    except FileNotFoundError:
        raise Fail("MODEL_UNAVAILABLE", f"fm not found at {FM} — requires macOS 27")
    except subprocess.TimeoutExpired:
        raise Fail("TIMEOUT", f"fm exceeded {timeout_s:g}s", retryable=True)
    if p.returncode != 0:
        raise Fail(classify(p.stderr), (p.stderr or f"fm exited {p.returncode}").strip()[:500], retryable=True, raw=(p.stderr or "")[:2000])
    return extract_json(p.stdout)


# ----- ops --------------------------------------------------------------------------------------

def organize_mode():
    if schema_path("organize.json"):
        return "nested"
    if schema_path("organize-labels.json") and schema_path("organize-assign.json"):
        return "two-call"
    return "missing"


def op_ping(_payload, _opts):
    if not os.path.exists(FM):
        return {"hostVersion": HOST_VERSION, "fmPath": FM, "fmAvailable": False,
                "fmMessage": f"fm not found at {FM} — requires macOS 27", "schemasOk": False, "organizeMode": organize_mode()}
    try:
        avail = subprocess.run([FM, "available", "--model", "system"], capture_output=True, text=True, timeout=15, env=fm_env())
        ok, msg = avail.returncode == 0, (avail.stdout + avail.stderr).strip()[:300]
    except subprocess.TimeoutExpired:
        ok, msg = False, "fm available timed out"
    mode = organize_mode()
    return {"hostVersion": HOST_VERSION, "fmPath": FM, "fmAvailable": ok, "fmMessage": msg,
            "schemasOk": bool(schema_path("name.json")) and mode != "missing", "organizeMode": mode}


def op_name(payload, opts):
    schema = schema_path("name.json")
    if not schema:
        raise Fail("SCHEMA_MISSING", os.path.join(SCHEMAS, "name.json"))
    prompt = prompts.build_name_prompt(payload, strict=opts.get("strict", False))
    check_budget(prompt, len(payload["items"]))
    out = run_fm(prompt, schema, opts["model"], opts["timeout_s"])
    try:
        return validate.validate_name(out, payload), len(prompt), "name"
    except validate.ValidationError as e:
        raise Fail("BAD_MODEL_OUTPUT", str(e), retryable=True, raw=json.dumps(out, ensure_ascii=False)[:2000])


def op_organize(payload, opts):
    strict = opts.get("strict", False)
    mode = organize_mode()
    try:
        if mode == "nested":
            prompt = prompts.build_organize_prompt(payload, strict=strict)
            check_budget(prompt, len(payload["items"]))
            out = run_fm(prompt, schema_path("organize.json"), opts["model"], opts["timeout_s"])
            return validate.validate_organize(out, payload), len(prompt), "nested"
        if mode == "two-call":
            p1 = prompts.build_labels_prompt(payload, strict=strict)
            check_budget(p1, len(payload["items"]))
            labels = run_fm(p1, schema_path("organize-labels.json"), opts["model"], opts["timeout_s"])
            names = [x for x in (labels.get("labels") or []) if isinstance(x, str)] if isinstance(labels, dict) else []
            p2 = prompts.build_assign_prompt(payload, names, strict=strict)
            check_budget(p2, len(payload["items"]))
            assign = run_fm(p2, schema_path("organize-assign.json"), opts["model"], opts["timeout_s"])
            return validate.organize_from_two_calls(labels, assign, payload), len(p1) + len(p2), "two-call"
    except validate.ValidationError as e:
        raise Fail("BAD_MODEL_OUTPUT", str(e), retryable=True)
    raise Fail("SCHEMA_MISSING", os.path.join(SCHEMAS, "organize.json"))


def handle(req):
    """One validated request → one reply object. Never raises."""
    rid = req.get("id") if isinstance(req, dict) else None
    t0 = time.time()
    try:
        req = validate_request(req)
        rid = req.get("id")
        raw_opts = req.get("opts") or {}
        timeout_ms = raw_opts.get("timeoutMs", 45000)
        timeout_ms = timeout_ms if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool) else 45000
        opts = {"model": raw_opts.get("model", "system"), "strict": bool(raw_opts.get("strict")),
                "timeout_s": max(5.0, min(120.0, timeout_ms / 1000))}
        op = req["op"]
        if op == "ping":
            return {"v": 1, "id": rid, "ok": True, "result": op_ping(req["payload"], opts)}
        fn = op_name if op == "name" else op_organize
        result, chars, path = fn(req["payload"], opts)
        return {"v": 1, "id": rid, "ok": True, "result": result,
                "meta": {"ms": int((time.time() - t0) * 1000), "model": opts["model"], "promptChars": chars, "path": path}}
    except Fail as f:
        return error_reply(rid, f)
    except Exception as e:  # a bug here must still produce a reply, not a silent crash
        return error_reply(rid, Fail("FM_ERROR", f"host error: {type(e).__name__}: {e}"))


# ----- logging ----------------------------------------------------------------------------------

def log_request(req, reply, ms, debug_opt):
    """One JSON line per request when debugging is on; never the prompt, titles or URLs."""
    if not (debug_opt or os.path.isdir(os.path.join(SUPPORT, "debug"))):
        return
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        path = os.path.join(LOG_DIR, "host.log")
        if os.path.exists(path) and os.path.getsize(path) > LOG_MAX_BYTES:
            os.replace(path, path + ".1")
        payload = req.get("payload") if isinstance(req, dict) else None
        line = {"at": int(time.time()), "op": req.get("op") if isinstance(req, dict) else None, "ms": ms,
                "ok": reply.get("ok"), "code": (reply.get("error") or {}).get("code"),
                "items": len(payload.get("items", [])) if isinstance(payload, dict) else 0,
                "promptChars": (reply.get("meta") or {}).get("promptChars"),
                "replyBytes": len(json.dumps(reply.get("result") or {}))}
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
    except OSError:
        pass


# ----- CLI entry points ---------------------------------------------------------------------------

def install_schemas():
    os.makedirs(SCHEMAS, exist_ok=True)
    ok = True

    def write(name, args):
        try:
            p = subprocess.run([FM, *args], capture_output=True, text=True, timeout=30, env=fm_env())
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            print(f"  {name}: fm failed ({e})", file=sys.stderr)
            return False
        if p.returncode != 0 or not p.stdout.strip():
            print(f"  {name}: fm schema exited {p.returncode}: {p.stderr.strip()[:200]}", file=sys.stderr)
            return False
        with open(os.path.join(SCHEMAS, name), "w", encoding="utf-8") as f:
            f.write(p.stdout)
        print(f"  wrote {os.path.join(SCHEMAS, name)}")
        return True

    ok &= write("name.json", SCHEMA_COMMANDS["name.json"])
    if write("organize.json", SCHEMA_COMMANDS["organize.json"]):
        for name in FALLBACK_SCHEMA_COMMANDS:
            try:
                os.remove(os.path.join(SCHEMAS, name))
            except FileNotFoundError:
                pass
    else:
        print("  nested organize schema unsupported; using the two-call fallback", file=sys.stderr)
        try:
            os.remove(os.path.join(SCHEMAS, "organize.json"))
        except FileNotFoundError:
            pass
        for name, args in FALLBACK_SCHEMA_COMMANDS.items():
            ok &= write(name, args)
    return 0 if ok else 1


FIXTURE = {
    "items": [
        {"i": 0, "title": "Tokio - An asynchronous Rust runtime", "url": "https://tokio.rs/",
         "description": "Tokio is an asynchronous runtime for the Rust programming language."},
        {"i": 1, "title": "async-std", "url": "https://async.rs/", "description": "Async version of the Rust standard library."},
        {"i": 2, "title": "Asynchronous Programming in Rust", "url": "https://rust-lang.github.io/async-book/", "description": ""},
    ],
    "siblingTitles": [],
}


def selftest():
    failures = 0

    def check(label, ok, detail=""):
        nonlocal failures
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'} {label}{f': {detail}' if detail else ''}")

    ping = op_ping({}, {})
    check("fm found", os.path.exists(FM), FM)
    check("model available (fm available --model system)", ping["fmAvailable"], ping["fmMessage"])
    for name in ["name.json", *(["organize.json"] if organize_mode() == "nested" else list(FALLBACK_SCHEMA_COMMANDS))]:
        path = os.path.join(SCHEMAS, name)
        readable = os.path.isfile(path) and os.path.getsize(path) > 0
        check(f"schema {name}", readable, path if readable else "missing: run grove-host --install-schemas")
    check("allowed origin pinned", "<" not in ALLOWED_ORIGIN, ALLOWED_ORIGIN)
    if ping["fmAvailable"] and schema_path("name.json"):
        reply = handle({"v": 1, "id": "selftest", "op": "name", "payload": json.loads(json.dumps(FIXTURE)), "opts": {"timeoutMs": 45000}})
        if reply["ok"]:
            check("fixture naming round-trip", True, f"{reply['result']['emoji']} {reply['result']['title']} in {reply['meta']['ms']} ms")
        else:
            check("fixture naming round-trip", False, f"{reply['error']['code']}: {reply['error']['message']}")
    return 0 if failures == 0 else 1


def manifest_for(path):
    return {"name": HOST_NAME, "description": "Grove: names tab groups with Apple's on-device model",
            "path": os.path.abspath(path), "type": "stdio", "allowed_origins": [ALLOWED_ORIGIN]}


def origin_ok(arg):
    return isinstance(arg, str) and arg.rstrip("/") + "/" == ALLOWED_ORIGIN


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "--selftest":
        return selftest()
    if argv and argv[0] == "--install-schemas":
        return install_schemas()
    if argv and argv[0] == "--print-manifest":
        print(json.dumps(manifest_for(argv[1] if len(argv) > 1 else os.path.realpath(__file__)), indent=2))
        return 0
    if argv and argv[0] == "--version":
        print(HOST_VERSION)
        return 0
    if not argv or not origin_ok(argv[0]):
        write_frame(error_reply(None, Fail("FORBIDDEN_ORIGIN", "origin not allowed")))
        return 1
    t0 = time.time()
    try:
        req = read_frame()
    except Fail as f:
        write_frame(error_reply(None, f))
        return 0
    if req is None:
        return 0
    reply = handle(req)
    write_frame(reply)
    debug = isinstance(req, dict) and isinstance(req.get("opts"), dict) and bool(req["opts"].get("debug"))
    log_request(req, reply, int((time.time() - t0) * 1000), debug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
