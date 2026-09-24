import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import unittest

from support import HOST_DIR, HOST_SCRIPT, ITEMS3, HostCase, frame, host, unframe


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

    def test_store_origin_is_accepted_once_set(self):
        store = "chrome-extension://" + "b" * 32 + "/"
        self.assertFalse(host.origin_ok(store))
        saved, host.STORE_ORIGIN = host.STORE_ORIGIN, store
        try:
            self.assertTrue(host.origin_ok(store))
            self.assertTrue(host.origin_ok(host.ALLOWED_ORIGIN))
            self.assertEqual(host.manifest_for("/x/diagonal-host")["allowed_origins"], [host.ALLOWED_ORIGIN, store])
        finally:
            host.STORE_ORIGIN = saved

    def test_origin_is_pinned(self):
        self.assertRegex(host.ALLOWED_ORIGIN, r"^chrome-extension://[a-p]{32}/$")


class Ping(HostCase):
    def test_ping_reports_fm_and_schemas(self):
        r = self.call("ping")
        self.assertTrue(r["ok"])
        self.assertEqual(r["result"]["fmPath"], self.fm)
        self.assertTrue(r["result"]["fmAvailable"])
        self.assertTrue(r["result"]["schemasOk"])
        self.assertEqual(r["result"]["organizeMode"], "topics")

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

    def test_ping_says_why_schemas_could_not_be_written(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        self.control({"schema_fail": True})
        r = self.call("ping")
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["result"]["schemasOk"])
        self.assertIn("fm could not write", r["result"]["schemaMessage"])

    def test_ping_writes_missing_schemas_once_fm_works(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        r = self.call("ping")
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["result"]["schemasOk"])
        self.assertEqual(sorted(f for f in os.listdir(os.path.join(self.support, "schemas")) if f != "version"), ["name.json", "topics.json"])

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
        self.assertEqual(argv[:7], ["respond", "--model", "system", "--no-stream", "--schema", os.path.join(self.support, "schemas", "name.json"), "-i"])
        self.assertIn("You name a browser tab group", argv[7])
        self.assertEqual(len(argv), 8)
        # Tab text goes on stdin, never into argv where `ps` would show it.
        self.assertIn("tokio.rs", self.stdin_log()[0])
        self.assertNotIn("tokio", " ".join(argv))

    def test_json_wrapped_in_prose_and_fence(self):
        self.respond('Sure! Here it is:\n```json\n{"title": "Rust async", "emoji": "🦀"}\n```')
        r = self.call("name", {"items": ITEMS3})
        self.assertEqual(r["result"]["title"], "Rust async")

    def test_emoji_outside_list_falls_back_to_category_default(self):
        self.respond(json.dumps({"title": "Code review queue", "emoji": "🦄"}))
        items = [{"title": "PR 1", "url": "https://github.com/a/b/pull/1"}, {"title": "PR 2", "url": "https://github.com/a/b/pull/2"}]
        r = self.call("name", {"items": items})
        self.assertEqual(r["result"]["emoji"], "💻")

    def test_pcc_falls_back_to_the_on_device_model(self):
        # fm on macOS 27 rejects --model pcc; an older setting must not break naming.
        self.respond(json.dumps({"title": "Rust async", "emoji": "🦀"}))
        r = self.call("name", {"items": ITEMS3}, model="pcc")
        self.assertTrue(r["ok"], r)
        argv = [a for a in self.argv_log() if a[0] == "respond"][0]
        self.assertEqual(argv[1:3], ["--model", "system"])

    def test_guardrail_refusal_is_retried_permissively_once(self):
        self.control({"respond_queue": [
            {"stderr": "Error: The model's safety guardrails were triggered.\n", "exit": 1},
            {"stdout": json.dumps({"title": "Rust async", "emoji": "🦀"})},
        ]})
        r = self.call("name", {"items": ITEMS3})
        self.assertTrue(r["ok"], r)
        calls = [a for a in self.argv_log() if a[0] == "respond"]
        self.assertEqual(len(calls), 2)
        self.assertNotIn("--guardrails", calls[0])
        self.assertEqual(calls[1][-2:], ["--guardrails", "permissive-content-transformations"])

    def test_context_overflow_is_over_budget(self):
        self.respond(stderr="Error: The session's transcript exceeded the model's context size.\n", exit=1)
        self.assertEqual(self.call("name", {"items": ITEMS3})["error"]["code"], "OVER_BUDGET")

    def test_prompt_never_contains_tab_ids(self):
        self.respond(json.dumps({"title": "Rust async", "emoji": "🦀"}))
        self.call("name", {"items": [dict(it, id=987654) for it in ITEMS3]})
        prompt = self.stdin_log()[0]
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

    def test_page_text_is_shortened_before_giving_up(self):
        # 40 tabs with long page text don't fit at 500 chars each, but do once the text is shortened.
        items = [{"title": f"Page {n}", "url": f"https://example.com/{n}", "description": "word " * 100} for n in range(40)]
        self.respond(json.dumps({"title": "Reading list", "emoji": "📚"}))
        r = self.call("name", {"items": items})
        self.assertTrue(r["ok"], r)
        body = self.stdin_log()[0]
        self.assertLessEqual(len(body), host.CHAR_BUDGET)
        self.assertIn("word", body)

    def test_over_budget_precheck_reports_allowed_items(self):
        big = [{"title": "t" * 120, "url": "https://example.com/" + "p" * 280, "description": "d" * 300} for _ in range(120)]
        r = self.call("name", {"items": big})
        self.assertEqual(r["error"]["code"], "OVER_BUDGET")
        self.assertGreaterEqual(r["error"]["allowedItems"], 1)
        self.assertLess(r["error"]["allowedItems"], 120)
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
        argv = [a for a in self.argv_log() if a[0] == "respond"][0]
        self.assertIn("Reply with only the object", argv[argv.index("-i") + 1])


class Organize(HostCase):
    ITEMS = ITEMS3 + [
        {"title": "Hotels in Lisbon", "url": "https://booking.com/lisbon"},
        {"title": "Lisbon travel guide", "url": "https://lonelyplanet.com/portugal/lisbon"},
        {"title": "Random page", "url": "https://example.org/"},
        {"title": "Pasta recipe", "url": "https://cooking.example/pasta"},
        {"title": "Rice recipe", "url": "https://cooking.example/rice"},
    ]
    EXISTING = [{"g": 0, "title": "Lisbon trip", "samples": ["Flights to Lisbon", "Lisbon metro map"]}]

    def topics(self, pairs):
        self.respond(json.dumps({"tabs": [{"index": i, "topic": t} for i, t in pairs]}))

    def test_tabs_with_one_topic_form_groups_and_join_existing_ones(self):
        # Indexes 8 and 9 are the existing group's example tabs (numbered after the 8 tabs to sort).
        self.topics([(0, "Programming"), (1, "programming"), (2, "Programming."), (3, "Travel"), (4, "travel"),
                     (5, "Other"), (6, "Cooking"), (7, "Cooking"), (8, "Travel"), (9, "Travel")])
        r = self.call("organize", {"items": self.ITEMS, "existingGroups": self.EXISTING, "maxGroups": 4})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["meta"]["path"], "topics")
        groups = r["result"]["groups"]
        self.assertEqual(groups[0], {"title": "", "emoji": "", "color": "", "existing": 0, "members": [3, 4]})
        new = sorted(g["members"] for g in groups[1:])
        self.assertEqual(new, [[0, 1, 2], [6, 7]])
        self.assertTrue(all(g["title"] == "" for g in groups[1:]))  # the naming loop titles new groups
        self.assertEqual(r["result"]["leftovers"], [5])

    def test_new_groups_are_named_right_away(self):
        self.control({"respond_queue": [
            {"stdout": json.dumps({"tabs": [{"index": i, "topic": t} for i, t in
                                            [(0, "Programming"), (1, "Programming"), (2, "Programming"), (6, "Cooking"), (7, "Cooking")]]})},
            {"stdout": json.dumps({"title": "Rust async runtimes", "emoji": "🦀"})},
            {"stderr": "Error: The model's safety guardrails were triggered.\n", "exit": 1},
            {"stderr": "Error: The model's safety guardrails were triggered.\n", "exit": 1},
        ]})
        r = self.call("organize", {"items": self.ITEMS, "existingGroups": self.EXISTING, "maxGroups": 4})
        self.assertTrue(r["ok"], r)
        by_members = {tuple(g["members"]): g for g in r["result"]["groups"]}
        self.assertEqual((by_members[(0, 1, 2)]["title"], by_members[(0, 1, 2)]["emoji"]), ("Rust async runtimes", "🦀"))
        self.assertEqual(by_members[(6, 7)]["title"], "")  # naming failed: the extension's naming loop takes it
        name_calls = self.stdin_log()[1:]
        self.assertIn("Tokio", name_calls[0])
        self.assertIn('"Lisbon trip"', name_calls[0])  # existing titles are off limits

    def test_a_topic_of_one_tab_is_a_leftover(self):
        self.topics([(0, "Programming"), (1, "Programming"), (2, "Rust"), (3, "Travel"), (4, "Travel"), (5, "Web"), (6, "Food"), (7, "Cooking")])
        r = self.call("organize", {"items": self.ITEMS, "maxGroups": 4})
        self.assertEqual(sorted(g["members"] for g in r["result"]["groups"]), [[0, 1], [3, 4]])
        self.assertEqual(r["result"]["leftovers"], [2, 5, 6, 7])

    def test_prompt_rules_in_instructions_and_tabs_on_stdin(self):
        self.topics([(0, "Programming")])
        self.call("organize", {"items": self.ITEMS, "existingGroups": self.EXISTING})
        argv = [a for a in self.argv_log() if a[0] == "respond"][0]
        instructions = argv[argv.index("-i") + 1]
        self.assertIn("broad topics", instructions)
        self.assertNotIn("Lisbon", " ".join(argv))  # no tab or group text in the process list
        body = self.stdin_log()[0]
        self.assertIn("4 | Lisbon travel guide", body)
        self.assertIn("8 | Flights to Lisbon | - | -", body)

    def test_no_topics_is_bad_output(self):
        self.respond(json.dumps({"tabs": []}))
        r = self.call("organize", {"items": self.ITEMS})
        self.assertEqual(r["error"]["code"], "BAD_MODEL_OUTPUT")

    def test_context_overflow_suggests_a_smaller_batch(self):
        self.respond(stderr="Error: The session's transcript exceeded the model's context size.\n", exit=1)
        r = self.call("organize", {"items": self.ITEMS})
        self.assertEqual(r["error"]["code"], "OVER_BUDGET")
        self.assertEqual(r["error"]["allowedItems"], 5)


class InstallSchemas(HostCase):
    def test_writes_name_and_topics(self):
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        code, _, p = self.run_host(args=["--install-schemas"])
        self.assertEqual(code, 0, p.stderr)
        self.assertEqual(sorted(os.listdir(os.path.join(self.support, "schemas"))), ["name.json", "topics.json", "version"])

    def test_nested_object_gets_its_schema_from_fm_first(self):
        # Real fm: `--object tabs` must be followed by `--schema <json>` for the item's own schema.
        for f in os.listdir(os.path.join(self.support, "schemas")):
            os.remove(os.path.join(self.support, "schemas", f))
        code, _, p = self.run_host(args=["--install-schemas"])
        self.assertEqual(code, 0, p.stderr)
        calls = [a for a in self.argv_log() if a[0] == "schema"]
        self.assertTrue(any("TabTopic" in a for a in calls))
        topics = next(a for a in calls if "Topics" in a)
        i = topics.index("--object")
        self.assertEqual(topics[i + 1:i + 3], ["tabs", "--schema"])
        self.assertIn('"args"', topics[i + 3])  # the fake fm's output for the TabTopic schema
        self.assertEqual(topics[i + 4], "--array")

    def test_schemas_from_an_older_host_are_replaced(self):
        d = os.path.join(self.support, "schemas")
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        for name in ("name.json", "organize-labels.json", "organize-assign.json"):
            open(os.path.join(d, name), "w").write("{}")
        r = self.call("ping")
        self.assertTrue(r["result"]["schemasOk"], r)
        self.assertEqual(r["result"]["organizeMode"], "topics")
        self.assertEqual(sorted(os.listdir(d)), ["name.json", "topics.json", "version"])

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


class Register(HostCase):
    def make_profile(self, rel, browsing=True):
        d = os.path.join(self.tmp, "appsupport", rel)
        os.makedirs(os.path.join(d, "Default"))
        open(os.path.join(d, "Local State"), "w").write("{}")
        if browsing:
            open(os.path.join(d, "Default", "History"), "w").write("")
        return d

    def setUp(self):
        super().setUp()
        self.env["DIAGONAL_APP_SUPPORT"] = os.path.join(self.tmp, "appsupport")
        self.host_copy = os.path.join(self.tmp, "bin", "diagonal-host.py")
        os.makedirs(os.path.dirname(self.host_copy))
        shutil.copy(HOST_SCRIPT, self.host_copy)
        for f in ("prompts.py", "validate.py", "emoji.txt"):
            shutil.copy(os.path.join(HOST_DIR, f), os.path.dirname(self.host_copy))

    def run_copy(self, *args):
        return subprocess.run([sys.executable, self.host_copy, *args], capture_output=True, text=True, env=self.env, timeout=30)

    def test_registers_with_every_chromium_browser_and_only_those(self):
        origin = self.make_profile("BraveSoftware/Brave-Origin")
        chrome = self.make_profile("Google/Chrome")
        arc = self.make_profile("Arc/User Data")
        unknown = self.make_profile("SomeVendor/NewBrowser")
        electron = self.make_profile("Slack", browsing=False)
        p = self.run_copy("--register", self.host_copy)
        self.assertEqual(p.returncode, 0, p.stderr)
        for d in (origin, chrome, arc, unknown):
            m = json.load(open(os.path.join(d, "NativeMessagingHosts", "io.diagonal.host.json")))
            self.assertEqual(m["path"], self.host_copy)
            self.assertEqual(m["allowed_origins"], [host.ALLOWED_ORIGIN])
        self.assertFalse(os.path.exists(os.path.join(electron, "NativeMessagingHosts")))
        self.assertIn("registered: BraveSoftware/Brave-Origin", p.stdout)

        p = self.run_copy("--unregister")
        self.assertEqual(p.returncode, 0, p.stderr)
        for d in (origin, chrome, arc, unknown):
            self.assertFalse(os.path.exists(os.path.join(d, "NativeMessagingHosts", "io.diagonal.host.json")))

    def test_names_a_host_that_cannot_run(self):
        self.make_profile("Google/Chrome")
        os.chmod(self.host_copy, 0o644)
        p = self.run_copy("--register", self.host_copy)
        self.assertEqual(p.returncode, 1)
        self.assertIn("missing or not executable", p.stderr)

    def test_no_browser_found(self):
        os.makedirs(self.env["DIAGONAL_APP_SUPPORT"])
        p = self.run_copy("--register", self.host_copy)
        self.assertEqual(p.returncode, 1)
        self.assertIn("No Chromium browser found", p.stderr)


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
