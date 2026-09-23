import io
import json
import os
import re
import struct
import unittest

from support import HOST_DIR, ITEMS3, HostCase, frame, host, unframe


class Framing(HostCase):
    def test_round_trip(self):
        obj = {"v": 1, "id": "x", "op": "ping", "payload": {"t": "ünïcode 🦀"}}
        self.assertEqual(host.read_frame(io.BytesIO(frame(obj))), obj)
        out = host.encode_frame(obj)
        self.assertEqual(struct.unpack("<I", out[:4])[0], len(out) - 4)
        self.assertEqual(unframe(out), obj)

    def test_frame_over_64_mib_rejected(self):
        code, reply, _ = self.run_host(raw=struct.pack("<I", 64 * 1024 * 1024 + 1))
        self.assertEqual(code, 0)
        self.assertEqual(reply["error"]["code"], "BAD_REQUEST")

    def test_short_read_exits_zero_silently(self):
        code, reply, p = self.run_host(raw=b"\x01\x00")
        self.assertEqual(code, 0)
        self.assertIsNone(reply)
        self.assertEqual(p.stdout, b"")

    def test_non_json_is_bad_request(self):
        data = b"not json"
        code, reply, _ = self.run_host(raw=struct.pack("<I", len(data)) + data)
        self.assertEqual(reply["error"]["code"], "BAD_REQUEST")

    def test_reply_over_1_mb_is_replaced(self):
        out = host.encode_frame({"v": 1, "id": "x", "ok": True, "result": {"big": "x" * (1024 * 1024 + 10)}})
        self.assertLessEqual(len(out), 1024 * 1024 + 4)
        self.assertEqual(unframe(out)["error"]["code"], "BAD_MODEL_OUTPUT")


class Origin(HostCase):
    def test_wrong_origin_is_forbidden(self):
        code, reply, _ = self.run_host({"v": 1, "op": "ping"}, origin="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")
        self.assertEqual(code, 1)
        self.assertEqual(reply["error"]["code"], "FORBIDDEN_ORIGIN")

    def test_missing_origin_is_forbidden(self):
        code, reply, _ = self.run_host({"v": 1, "op": "ping"}, args=[])
        self.assertEqual(reply["error"]["code"], "FORBIDDEN_ORIGIN")

    def test_origin_without_trailing_slash_is_accepted(self):
        code, reply, _ = self.run_host({"v": 1, "id": "p", "op": "ping", "payload": {}}, origin=host.ALLOWED_ORIGIN.rstrip("/"))
        self.assertTrue(reply["ok"])

    def test_origin_is_pinned(self):
        self.assertRegex(host.ALLOWED_ORIGIN, r"^chrome-extension://[a-p]{32}/$")


class Ping(HostCase):
    def test_ping_reports_fm_and_schemas(self):
        r = self.call("ping")
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["fmPath"], self.fm)
        self.assertTrue(r["result"]["fmAvailable"])
        self.assertTrue(r["result"]["schemasOk"])
        self.assertEqual(r["result"]["organizeMode"], "nested")

    def test_ping_model_unavailable(self):
        self.control({"available": {"stderr": "Apple Intelligence is not enabled", "exit": 1}})
        r = self.call("ping")
        self.assertFalse(r["result"]["fmAvailable"])
        self.assertIn("Apple Intelligence", r["result"]["fmMessage"])

    def test_ping_license_not_accepted(self):
        self.control({"license": True})
        r = self.call("ping")
        self.assertFalse(r["result"]["fmAvailable"])
        self.assertTrue(r["result"]["licenseRequired"])
        self.assertIn("sudo fm license", r["result"]["fmMessage"])

    def test_ping_writes_missing_schemas_once_fm_works(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        r = self.call("ping")
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["result"]["schemasOk"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.support, "schemas"))), ["name.json", "organize.json"])

    def test_ping_without_fm(self):
        self.env["DIAGONAL_FM"] = os.path.join(self.tmp, "missing-fm")
        r = self.call("ping")
        self.assertFalse(r["result"]["fmAvailable"])
        self.assertIn("requires macOS 27", r["result"]["fmMessage"])


class Name(HostCase):
    def test_success_and_argument_shape(self):
        self.respond(json.dumps({"title": "rust async runtimes.", "emoji": "🦀"}))
        r = self.call("name", {"items": ITEMS3, "siblingTitles": []})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"], {"title": "Rust async runtimes", "emoji": "🦀"})
        self.assertGreater(r["meta"]["promptChars"], 0)
        argv = [a for a in self.argv_log() if a[0] == "respond"][0]
        self.assertEqual(argv[:6], ["respond", "--model", "system", "--no-stream", "--schema", os.path.join(self.support, "schemas", "name.json")])
        self.assertEqual(argv[6], "--")
        self.assertIn("tokio.rs", argv[7])
        self.assertEqual(len(argv), 8)

    def test_json_wrapped_in_prose_and_fence(self):
        self.respond('Sure! Here it is:\n```json\n{"title": "Rust async", "emoji": "🦀"}\n```')
        r = self.call("name", {"items": ITEMS3})
        self.assertEqual(r["result"]["title"], "Rust async")

    def test_emoji_outside_list_falls_back_to_category_default(self):
        self.respond(json.dumps({"title": "Code review queue", "emoji": "🦄"}))
        items = [{"title": "PR 1", "url": "https://github.com/a/b/pull/1"}, {"title": "PR 2", "url": "https://github.com/a/b/pull/2"}]
        r = self.call("name", {"items": items})
        self.assertEqual(r["result"]["emoji"], "💻")

    def test_pcc_only_when_asked(self):
        self.respond(json.dumps({"title": "Rust async", "emoji": "🦀"}))
        self.call("name", {"items": ITEMS3}, model="pcc")
        argv = [a for a in self.argv_log() if a[0] == "respond"][0]
        self.assertEqual(argv[1:3], ["--model", "pcc"])

    def test_prompt_never_contains_tab_ids(self):
        self.respond(json.dumps({"title": "Rust async", "emoji": "🦀"}))
        self.call("name", {"items": [dict(it, id=987654) for it in ITEMS3]})
        prompt = [a for a in self.argv_log() if a[0] == "respond"][0][-1]
        self.assertNotIn("987654", prompt)


class ErrorCodes(HostCase):
    def expect(self, code, **respond):
        self.respond(**respond)
        r = self.call("name", {"items": ITEMS3})
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["error"]["code"], code, r)
        return r

    def test_model_unavailable(self):
        self.expect("MODEL_UNAVAILABLE", stderr="Error: The model is not available. Enable Apple Intelligence.", exit=1)

    def test_fm_missing(self):
        self.env["DIAGONAL_FM"] = os.path.join(self.tmp, "nope")
        r = self.call("name", {"items": ITEMS3})
        self.assertEqual(r["error"]["code"], "MODEL_UNAVAILABLE")
        self.assertIn("requires macOS 27", r["error"]["message"])

    def test_license_required(self):
        self.control({"license": True})
        r = self.call("name", {"items": ITEMS3})
        self.assertEqual(r["error"]["code"], "LICENSE_REQUIRED", r)
        self.assertIn("sudo fm license", r["error"]["message"])
        self.assertFalse(r["error"]["retryable"])

    def test_rate_limited(self):
        self.expect("RATE_LIMITED", stderr="rate limit exceeded, try later", exit=1)

    def test_over_budget_from_fm(self):
        self.expect("OVER_BUDGET", stderr="The prompt exceeds the context window", exit=1)

    def test_over_budget_precheck_reports_allowed_items(self):
        big = [{"title": "t" * 120, "url": "https://example.com/" + "p" * 280, "description": "d" * 300} for _ in range(30)]
        r = self.call("name", {"items": big})
        self.assertEqual(r["error"]["code"], "OVER_BUDGET")
        self.assertGreaterEqual(r["error"]["allowedItems"], 1)
        self.assertLess(r["error"]["allowedItems"], 30)
        self.assertEqual([a for a in self.argv_log() if a[0] == "respond"], [])

    def test_guardrail(self):
        self.expect("GUARDRAIL", stderr="Content blocked by safety guardrails", exit=1)

    def test_timeout(self):
        self.respond(stdout="{}", sleep=8)
        r = self.call("name", {"items": ITEMS3}, timeoutMs=1000)  # clamped to the 5 s minimum
        self.assertEqual(r["error"]["code"], "TIMEOUT")

    def test_bad_model_output_not_json(self):
        r = self.expect("BAD_MODEL_OUTPUT", stdout="I cannot do that.")
        self.assertIn("I cannot", r["error"]["raw"])

    def test_bad_model_output_fails_validation(self):
        self.expect("BAD_MODEL_OUTPUT", stdout=json.dumps({"title": "Tabs", "emoji": "🦀"}))

    def test_fm_error(self):
        self.expect("FM_ERROR", stderr="segmentation fault", exit=139)

    def test_schema_missing(self):
        os.remove(os.path.join(self.support, "schemas", "name.json"))
        self.control({"schema_fail": True})  # first-use repair fails too
        r = self.call("name", {"items": ITEMS3})
        self.assertEqual(r["error"]["code"], "SCHEMA_MISSING")

    def test_bad_request(self):
        for req in ({"v": 2, "op": "ping"}, {"v": 1, "op": "delete"}, {"v": 1, "op": "name", "payload": {"items": []}}, [1, 2]):
            code, reply, _ = self.run_host(req)
            self.assertEqual(reply["error"]["code"], "BAD_REQUEST", req)

    def test_strict_retry_appends_line(self):
        self.respond(json.dumps({"title": "Rust async", "emoji": "🦀"}))
        self.call("name", {"items": ITEMS3}, strict=True)
        prompt = [a for a in self.argv_log() if a[0] == "respond"][0][-1]
        self.assertIn("Reply with only the object", prompt)


class Organize(HostCase):
    ITEMS = ITEMS3 + [
        {"title": "Hotels in Lisbon", "url": "https://booking.com/lisbon"},
        {"title": "Lisbon travel guide", "url": "https://lonelyplanet.com/portugal/lisbon"},
        {"title": "Random page", "url": "https://example.org/"},
    ]

    def test_nested_path(self):
        self.respond(json.dumps({"groups": [
            {"title": "Rust async", "emoji": "🦀", "color": "orange", "existing": -1, "members": [0, 1, 2]},
            {"title": "", "emoji": "", "color": "", "existing": 0, "members": [3, 4]},
        ], "leftovers": [5]}))
        r = self.call("organize", {"items": self.ITEMS, "existingGroups": [{"g": 0, "title": "Lisbon trip"}], "maxGroups": 2})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["groups"][0], {"title": "", "emoji": "", "color": "", "existing": 0, "members": [3, 4]})
        self.assertEqual(r["result"]["groups"][1]["title"], "Rust async")
        self.assertEqual(r["result"]["leftovers"], [5])
        self.assertEqual(r["meta"]["path"], "nested")

    def test_two_call_fallback(self):
        os.remove(os.path.join(self.support, "schemas", "organize.json"))
        for name in ("organize-labels.json", "organize-assign.json"):
            open(os.path.join(self.support, "schemas", name), "w").write("{}")
        self.control({"respond_queue": [
            {"stdout": json.dumps({"labels": ["Rust async"], "emojis": ["🦀"], "colors": ["orange"]})},
            {"stdout": json.dumps({"assignment": [1, 1, 1, 0, 0, -1]})},
        ]})
        r = self.call("organize", {"items": self.ITEMS, "existingGroups": [{"g": 0, "title": "Lisbon trip"}], "maxGroups": 2})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["meta"]["path"], "two-call")
        groups = {g.get("existing", -1): g for g in r["result"]["groups"]}
        self.assertEqual(groups[0]["members"], [3, 4])
        self.assertEqual(groups[-1]["title"], "Rust async")
        self.assertEqual(groups[-1]["members"], [0, 1, 2])
        self.assertEqual(r["result"]["leftovers"], [5])
        prompts_sent = [a[-1] for a in self.argv_log() if a[0] == "respond"]
        self.assertEqual(len(prompts_sent), 2)
        self.assertIn("1 | Rust async", prompts_sent[1])


class InstallSchemas(HostCase):
    def test_nested_supported(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        code, _, p = self.run_host(args=["--install-schemas"])
        self.assertEqual(code, 0, p.stderr)
        self.assertEqual(sorted(os.listdir(os.path.join(self.support, "schemas"))), ["name.json", "organize.json"])

    def test_falls_back_to_two_flat_schemas(self):
        self.control({"schema_nested": False})
        code, _, p = self.run_host(args=["--install-schemas"])
        self.assertEqual(code, 0, p.stderr)
        self.assertEqual(sorted(os.listdir(os.path.join(self.support, "schemas"))), ["name.json", "organize-assign.json", "organize-labels.json"])


    def test_first_use_writes_missing_schemas(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        self.respond(json.dumps({"title": "Rust async runtimes", "emoji": "🦀"}))
        r = self.call("name", {"items": ITEMS3})
        self.assertTrue(r["ok"], r)
        self.assertIn("name.json", os.listdir(os.path.join(self.support, "schemas")))

    def test_first_use_without_the_terms_says_so(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        self.control({"license": True})
        r = self.call("name", {"items": ITEMS3})
        self.assertEqual(r["error"]["code"], "LICENSE_REQUIRED", r)

    def test_license_stops_early_without_claiming_nesting_is_unsupported(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        self.control({"license": True})
        code, _, p = self.run_host(args=["--install-schemas"])
        err = p.stderr.decode()
        self.assertEqual(code, 3, err)
        self.assertIn("sudo fm license", err)
        self.assertNotIn("unsupported", err)
        self.assertEqual(os.listdir(os.path.join(self.support, "schemas")), [])
        self.assertEqual(len(self.argv_log()), 1)  # stopped after the first refusal


class SelfTest(HostCase):
    def test_selftest_passes_with_a_working_fm(self):
        self.respond(json.dumps({"title": "Rust async runtimes", "emoji": "🦀"}))
        code, _, p = self.run_host(args=["--selftest"])
        out = p.stdout.decode()
        self.assertEqual(code, 0, out)
        self.assertIn("fixture naming round-trip: 🦀 Rust async runtimes", out)

    def test_selftest_fails_without_the_model(self):
        self.control({"available": {"stderr": "Model not downloaded", "exit": 1}})
        code, _, p = self.run_host(args=["--selftest"])
        self.assertEqual(code, 1)
        self.assertIn("FAIL model available", p.stdout.decode())

    def test_selftest_names_the_license_fix(self):
        self.control({"license": True})
        code, _, p = self.run_host(args=["--selftest"])
        out = p.stdout.decode()
        self.assertEqual(code, 1)
        self.assertIn("FAIL fm terms accepted: run: sudo fm license", out)

    def test_print_manifest(self):
        code, _, p = self.run_host(args=["--print-manifest", "/Users/me/.local/bin/diagonal-host"])
        m = json.loads(p.stdout)
        self.assertEqual(m["name"], "io.diagonal.host")
        self.assertEqual(m["path"], "/Users/me/.local/bin/diagonal-host")
        self.assertEqual(m["allowed_origins"], [host.ALLOWED_ORIGIN])


class Logging(HostCase):
    def test_logs_only_when_debug_on_and_never_the_prompt(self):
        self.respond(json.dumps({"title": "Rust async", "emoji": "🦀"}))
        self.call("name", {"items": ITEMS3})
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "logs", "host.log")))
        os.makedirs(os.path.join(self.support, "debug"))
        self.call("name", {"items": ITEMS3})
        log = open(os.path.join(self.tmp, "logs", "host.log"), encoding="utf-8").read()
        self.assertIn('"op": "name"', log)
        self.assertNotIn("tokio", log.lower())


class Privacy(unittest.TestCase):
    def test_no_network_imports(self):
        banned = re.compile(r"^\s*(import|from)\s+(socket|ssl|http|urllib\.request|urllib3|requests|ftplib|smtplib|asyncio|xmlrpc)\b", re.M)
        for name in ("diagonal-host.py", "prompts.py", "validate.py"):
            src = open(os.path.join(HOST_DIR, name), encoding="utf-8").read()
            self.assertIsNone(banned.search(src), name)


if __name__ == "__main__":
    unittest.main()
