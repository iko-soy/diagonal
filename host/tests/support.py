"""Shared fixtures: a temp dir holding the fake fm, its control file and the host's support dir."""
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

HOST_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
HOST_SCRIPT = os.path.join(HOST_DIR, "diagonal-host.py")
sys.path.insert(0, HOST_DIR)


def load_host():
    spec = importlib.util.spec_from_file_location("diagonal_host", HOST_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


host = load_host()
ORIGIN = host.ALLOWED_ORIGIN


def frame(obj):
    data = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def unframe(raw):
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw[:4])
    try:
        return json.loads(raw[4 : 4 + n].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None  # a CLI mode (--selftest etc.) printing plain text


ITEMS3 = [
    {"i": 0, "title": "Tokio - An asynchronous Rust runtime", "url": "https://tokio.rs/", "description": "Tokio is an asynchronous runtime for Rust."},
    {"i": 1, "title": "async-std", "url": "https://async.rs/", "description": "Async version of the Rust standard library."},
    {"i": 2, "title": "Asynchronous Programming in Rust", "url": "https://rust-lang.github.io/async-book/", "description": ""},
]


class HostCase(unittest.TestCase):
    """Each test gets a fresh temp dir with a fake fm and installed schemas."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="diagonal-host-test-")
        self.fm = os.path.join(self.tmp, "fm")
        with open(os.path.join(HOST_DIR, "tests", "fake_fm.py"), encoding="utf-8") as f:
            body = f.read()
        with open(self.fm, "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n" + body)
        os.chmod(self.fm, 0o755)
        self.support = os.path.join(self.tmp, "support")
        os.makedirs(os.path.join(self.support, "schemas"))
        for name in ("name.json", "topics.json"):
            with open(os.path.join(self.support, "schemas", name), "w") as f:
                f.write("{}")
        with open(os.path.join(self.support, "schemas", "version"), "w") as f:
            f.write(host.SCHEMA_VERSION + "\n")
        self.control({})
        self.env = {**os.environ, "DIAGONAL_FM": self.fm, "DIAGONAL_SUPPORT_DIR": self.support,
                    "DIAGONAL_LOG_DIR": os.path.join(self.tmp, "logs"), "HOME": self.tmp}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def control(self, data):
        with open(os.path.join(self.tmp, "control.json"), "w", encoding="utf-8") as f:
            json.dump(data, f)

    def respond(self, stdout="", stderr="", exit=0, sleep=0):
        self.control({"respond": {"stdout": stdout, "stderr": stderr, "exit": exit, "sleep": sleep}})

    def argv_log(self):
        path = os.path.join(self.tmp, "argv.log")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in open(path, encoding="utf-8")]

    def stdin_log(self):
        """The prompts `fm respond` read on stdin, in call order."""
        path = os.path.join(self.tmp, "stdin.log")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in open(path, encoding="utf-8")]

    def run_host(self, request=None, origin=ORIGIN, raw=None, args=None, timeout=30):
        stdin = raw if raw is not None else (frame(request) if request is not None else b"")
        argv = args if args is not None else [origin]
        p = subprocess.run([sys.executable, HOST_SCRIPT, *argv], input=stdin, capture_output=True, env=self.env, timeout=timeout)
        return p.returncode, unframe(p.stdout), p

    def call(self, op, payload=None, **opts):
        req = {"v": 1, "id": "t1", "op": op, "payload": payload if payload is not None else {}, "opts": {"model": "system", "timeoutMs": 45000, **opts}}
        code, reply, _ = self.run_host(req)
        self.assertEqual(code, 0)
        return reply
