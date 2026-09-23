"""A stand-in for /usr/bin/fm, driven by control.json next to it. Tests copy it into a temp dir.

control.json keys:
  respond:        {"stdout": str, "stderr": str, "exit": int, "sleep": float} for every `fm respond`
  respond_queue:  list of the same, consumed one per call before `respond` is used
  available:      {"stdout": str, "stderr": str, "exit": int} for `fm available`
  schema_nested:  false → `fm schema` with --object fails (simulates no nested-array support)
  license:        true → every command exits 69 with the terms notice, as fm does before `sudo fm license`
Every invocation's argv is appended to argv.log as one JSON line.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
# Copied from fm on macOS 27 (reported by a user's installer run).
LICENSE_NOTICE = ("YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.\n"
                  "Agreeing to the Apple Foundation Models CLI Legal Notice & Terms applies to every user on the machine, "
                  "so it must be run as a privileged user (e.g. 'sudo fm license').\n")


def main():
    argv = sys.argv[1:]
    with open(os.path.join(HERE, "argv.log"), "a", encoding="utf-8") as f:
        f.write(json.dumps(argv) + "\n")
    path = os.path.join(HERE, "control.json")
    control = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    cmd = argv[0] if argv else ""
    if control.get("license"):
        spec = {"stderr": LICENSE_NOTICE, "exit": 69}
    elif cmd == "available":
        spec = control.get("available", {"stdout": "available", "exit": 0})
    elif cmd == "schema":
        if "--object" in argv and control.get("schema_nested", True) is False:
            spec = {"stderr": "error: unknown option --object", "exit": 64}
        else:
            spec = {"stdout": json.dumps({"schema": argv[3] if len(argv) > 3 else "x", "args": argv[1:]}), "exit": 0}
    elif cmd == "respond":
        queue = control.get("respond_queue") or []
        if queue:
            spec = queue.pop(0)
            control["respond_queue"] = queue
            json.dump(control, open(path, "w", encoding="utf-8"))
        else:
            spec = control.get("respond", {"stdout": "{}", "exit": 0})
    else:
        spec = {"stderr": f"unknown command {cmd}", "exit": 2}
    if spec.get("sleep"):
        time.sleep(spec["sleep"])
    sys.stdout.write(spec.get("stdout", ""))
    sys.stderr.write(spec.get("stderr", ""))
    sys.exit(spec.get("exit", 0))


if __name__ == "__main__":
    main()
