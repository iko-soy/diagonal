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
    body = prompt.split("Tabs (index | title | address | description):", 1)[-1]
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
        prompt = sys.stdin.read()
        if prompt.startswith("You name"):
            found = topic_of(prompt.split("Tabs (", 1)[-1]) or ("Reading list", "📚", "grey")
            print(json.dumps({"title": found[0], "emoji": found[1]}))
            return
        if prompt.startswith("You sort"):
            buckets = {}
            leftovers = []
            for i, rest in items(prompt):
                t = topic_of(rest)
                if t:
                    buckets.setdefault(t, []).append(i)
                else:
                    leftovers.append(i)
            groups = [{"title": t[0], "emoji": t[1], "color": t[2], "existing": -1, "members": m} for t, m in buckets.items()]
            print(json.dumps({"groups": groups, "leftovers": leftovers}))
            return
    sys.stderr.write("unexpected fm call\n")
    sys.exit(1)


if __name__ == "__main__":
    main()
