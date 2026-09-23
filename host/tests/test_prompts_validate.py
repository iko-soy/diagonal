import os
import unittest

from support import HOST_DIR, ITEMS3, host  # noqa: F401  (sets sys.path)

import prompts
import validate

GOLDEN = os.path.join(HOST_DIR, "tests", "golden")
UPDATE = os.environ.get("UPDATE_GOLDEN") == "1"


def items24():
    topics = ["tokio", "serde", "axum", "hyper", "rayon", "clap"]
    return [{"i": n, "title": f"{topics[n % 6]} {n} - docs.rs", "url": f"https://docs.rs/{topics[n % 6]}/latest/{topics[n % 6]}/?search=x{n}&utm_source=y",
             "description": f"Documentation for the {topics[n % 6]} crate, part {n}."} for n in range(24)]


class Golden(unittest.TestCase):
    def check(self, name, text):
        path = os.path.join(GOLDEN, name)
        if UPDATE or not os.path.exists(path):
            os.makedirs(GOLDEN, exist_ok=True)
            open(path, "w", encoding="utf-8").write(text)
        self.assertEqual(text, open(path, encoding="utf-8").read())

    def test_name_3(self):
        p = prompts.build_name_prompt({"items": ITEMS3, "currentTitle": "Rust async", "siblingTitles": ["Lisbon trip"]})
        self.check("name-3.txt", p)
        self.assertLessEqual(len(p), 10_000)

    def test_name_24(self):
        p = prompts.build_name_prompt({"items": items24(), "siblingTitles": []})
        self.check("name-24.txt", p)
        self.assertLessEqual(len(p), 10_000)

    def test_organize(self):
        p = prompts.build_organize_prompt({"items": ITEMS3, "existingGroups": [{"g": 0, "title": "Lisbon trip", "samples": ["Hotels", "Flights"]}], "maxGroups": 1})
        self.check("organize-3.txt", p)


class Rendering(unittest.TestCase):
    def test_fields_respect_caps(self):
        it = {"i": 0, "title": "t|" * 200, "url": "https://www.example.com/" + "p" * 400, "description": "d " * 400}
        line = prompts.render_items([it])
        idx, title, addr, desc = line.split(" | ")
        self.assertLessEqual(len(title), 120)
        self.assertLessEqual(len(addr), 160)
        self.assertLessEqual(len(desc), 300)
        self.assertTrue(addr.startswith("example.com/"))

    def test_address(self):
        self.assertEqual(prompts.render_address("https://www.youtube.com/watch?v=abc"), "youtube.com/watch?v=abc")
        self.assertEqual(prompts.render_address("https://example.com/"), "example.com")
        self.assertEqual(prompts.render_address("https://docs.rs"), "docs.rs")

    def test_missing_description_is_dash(self):
        self.assertTrue(prompts.render_items([{"i": 0, "title": "a", "url": "https://a.com"}]).endswith("| -"))


class ValidateName(unittest.TestCase):
    def v(self, title, emoji="🦀"):
        return validate.validate_name({"title": title, "emoji": emoji}, {"items": ITEMS3})

    def test_repairs(self):
        self.assertEqual(self.v('"rust async runtimes."')["title"], "Rust async runtimes")
        self.assertEqual(self.v("Rust tabs group docs")["title"], "Rust docs")
        self.assertEqual(self.v("One two three four five")["title"], "One two three four")

    def test_rejects(self):
        for bad in ("Tabs", "Misc", "", None, 42, "x"):
            with self.assertRaises(validate.ValidationError, msg=bad):
                self.v(bad)

    def test_emoji_default(self):
        self.assertEqual(self.v("Rust async", "not-an-emoji")["emoji"], "🧭")
        self.assertEqual(self.v("Rust async", "✈")["emoji"], "✈️")


class ValidateOrganize(unittest.TestCase):
    payload = {"items": [{"url": f"https://a{n}.com"} for n in range(6)], "existingGroups": [{"g": 0, "title": "X"}], "maxGroups": 3}

    def v(self, out, **over):
        return validate.validate_organize(out, {**self.payload, **over})

    def test_duplicates_and_range(self):
        r = self.v({"groups": [{"title": "Rust async", "emoji": "🦀", "color": "red", "members": [0, 0, 1, 7, -2, True]}], "leftovers": []})
        self.assertEqual(r["groups"][0]["members"], [0, 1])
        self.assertEqual(r["leftovers"], [2, 3, 4, 5])

    def test_existing_out_of_range_becomes_new(self):
        r = self.v({"groups": [{"title": "Rust async", "emoji": "🦀", "color": "red", "existing": 5, "members": [0, 1]}]})
        self.assertNotIn("existing", r["groups"][0])

    def test_small_groups_and_bad_colours(self):
        r = self.v({"groups": [{"title": "Rust async", "emoji": "🦀", "color": "magenta", "members": [0, 1]},
                               {"title": "Lone tab here", "emoji": "🦀", "color": "red", "members": [2]}]})
        self.assertIn(r["groups"][0]["color"], validate.COLORS)
        self.assertEqual(r["leftovers"], [2, 3, 4, 5])

    def test_min_group_size(self):
        r = self.v({"groups": [{"title": "Rust async", "emoji": "🦀", "color": "red", "members": [0, 1]}]}, minGroupSize=3)
        self.assertEqual(r["groups"], [])

    def test_every_index_exactly_once(self):
        r = self.v({"groups": [{"title": "A b", "members": [0, 1]}, {"existing": 0, "members": [1, 2]}, {"title": "C d", "members": [3, 4]}], "leftovers": [4, 5, 5]})
        seen = [i for g in r["groups"] for i in g["members"]] + r["leftovers"]
        self.assertEqual(sorted(seen), list(range(6)))

    def test_max_groups(self):
        r = self.v({"groups": [{"title": f"Topic {c}", "members": [2 * k, 2 * k + 1]} for k, c in enumerate("abc")]}, maxGroups=2)
        self.assertEqual(len(r["groups"]), 2)
        self.assertEqual(len(r["leftovers"]), 2)

    def test_not_a_list(self):
        with self.assertRaises(validate.ValidationError):
            self.v({"groups": "nope"})


if __name__ == "__main__":
    unittest.main()
