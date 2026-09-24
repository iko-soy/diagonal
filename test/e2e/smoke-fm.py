"""A keyword-driven stand-in for /usr/bin/fm used by the Chromium smoke test (Linux CI has no fm)."""
import json
import re
import sys

TOPICS = [
    (("rust", "tokio", "async-std", "crate"), "Rust async runtimes", "🦀", "orange"),
    (("lisbon", "hotel", "flight", "travel"), "Lisbon trip planning", "✈️", "blue"),
    (("recipe", "pasta", "cook"), "Weeknight pasta recipes", "🍳", "yellow"),
]


def topic_of(text):
    t = text.lower()
    for words, label, emoji, color in TOPICS:
        if any(w in t for w in words):
            return label, emoji, color
    return None


def items(prompt):
    body = prompt.split("Tabs (index | title | address | what the page says):", 1)[-1]
    out = []
    for line in body.strip().splitlines():
        m = re.match(r"^(\d+) \| (.*)$", line)
        if m:
            out.append((int(m.group(1)), m.group(2)))
    return out


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(2)
    if argv[0] == "available":
        print("available")
        return
    if argv[0] == "schema":
        print(json.dumps({"schema": argv[1:]}))
        return
    if argv[0] == "respond":
        # Like the real fm: rules arrive with -i, the tab list on stdin.
        instructions = argv[argv.index("-i") + 1] if "-i" in argv else ""
        prompt = sys.stdin.read()
        if instructions.startswith("You name"):
            found = topic_of(prompt.split("Tabs (", 1)[-1]) or ("Reading list", "📚", "grey")
            print(json.dumps({"title": found[0], "emoji": found[1]}))
            return
        if instructions.startswith("You label"):
            tabs = []
            for i, rest in items(prompt):
                t = topic_of(rest)
                tabs.append({"index": i, "topic": t[0].split()[0] if t else f"Other {i}"})
            print(json.dumps({"tabs": tabs}))
            return
    sys.stderr.write("unexpected fm call\n")
    sys.exit(1)


if __name__ == "__main__":
    main()
