"""Section 9 prompt templates. Pure functions: payload in, Prompt out.

A Prompt has fixed `instructions` (passed to `fm respond -i`, so it may show in the process list and must hold
no tab or group text) and a `text` with everything from the browser (sent on stdin). Keeping the rules in
the instructions also makes it harder for a tab title to override them."""
from collections import namedtuple
from urllib.parse import urlsplit

from validate import COLORS, all_emoji

EMOJI_LIST = " ".join(all_emoji())
STRICT_LINE = "Reply with only the object, nothing before or after it."

Prompt = namedtuple("Prompt", "instructions text")


def size(p):
    return len(p.instructions) + len(p.text)


def _clean(s, limit):
    s = " ".join(str(s or "").split())
    return s.replace("|", "/")[:limit]


def render_address(url):
    """host without www. + path; the query is kept as the extension sent it (it already dropped tracking keys)."""
    try:
        u = urlsplit(str(url))
    except ValueError:
        return _clean(url, 160)
    host = (u.hostname or "").removeprefix("www.")
    if not host:
        return _clean(url, 160)
    path = "" if u.path in ("", "/") else u.path
    query = f"?{u.query}" if u.query else ""
    return _clean(host + path + query, 160)


def render_items(items, desc_cap=500):
    lines = []
    for it in items:
        desc = _clean(it.get("description"), desc_cap) or "-"
        lines.append(f"{it['i']} | {_clean(it.get('title'), 120)} | {render_address(it.get('url', ''))} | {desc}")
    return "\n".join(lines)


def _quoted(titles):
    return ", ".join(f'"{_clean(t, 60)}"' for t in titles)


def build_name_prompt(payload, strict=False, desc_cap=500):
    rules = [
        "- Title: 2 to 4 words, sentence case, no punctuation at the end, no quotes.",
        "- Describe the topic or task, not the website, unless every tab is the same site.",
        "- Never use the words tab, tabs, group, misc, various, stuff.",
        "- Write the title in the language most tab titles use.",
        f"- Emoji: exactly one, chosen from this list: {EMOJI_LIST}",
        "- If a current title is given, keep it exactly if it still fits; change it only if the tabs have clearly moved on.",
        "- Never reuse a name listed under other groups or not allowed.",
    ]
    if strict:
        rules.append(f"- {STRICT_LINE}")
    instructions = (
        "You name a browser tab group. Reply with a title and one emoji that describe what these tabs have in common.\n\n"
        "Rules:\n" + "\n".join(rules)
    )
    context = []
    current = payload.get("currentTitle")
    if current:
        context.append(f'Current title: "{_clean(current, 60)}"')
    siblings = payload.get("siblingTitles") or []
    if siblings:
        context.append(f"Other groups in this window: {_quoted(siblings)}")
    differ = payload.get("mustDifferFrom") or []
    if differ:
        context.append(f"Not allowed: {_quoted(differ)}")
    text = ("\n".join(context) + "\n\n" if context else "") + "Tabs (index | title | address | what the page says):\n" + render_items(payload["items"], desc_cap) + "\n"
    return Prompt(instructions, text)


# Organize asks for one broad topic per tab and the host groups tabs with the same topic. On fm (macOS 27)
# this was reliable where asking the model for whole groups was not: it set "existing" on nearly every
# new group, and specific topics gave every tab its own.
TOPICS_INSTRUCTIONS = (
    "You label browser tabs with broad topics so that related tabs can be grouped.\n\n"
    "Rules:\n"
    "- Give every listed index exactly one topic of one or two words.\n"
    "- Keep topics as general as possible, for example Programming, Travel, Cooking, Shopping, News, Finance, Music, Health, Work.\n"
    "- Use exactly the same topic words for tabs that belong together.\n"
    "- Group by what the page is about, not by website.\n"
    "- Write topics in English."
)


def topic_items(payload, desc_cap=500):
    """The tabs to sort, then up to two example tabs of each existing group, numbered after them.
    Returns (lines, owner) where owner maps an example's index to its group number."""
    items = payload["items"]
    lines = [render_items(items, desc_cap)] if items else []
    owner = {}
    n = len(items)
    for g in payload.get("existingGroups") or []:
        for sample in (g.get("samples") or [])[:2]:
            owner[n] = g["g"]
            lines.append(f"{n} | {_clean(sample, 120)} | - | -")
            n += 1
    return "\n".join(lines), owner


def build_topics_prompt(payload, strict=False, desc_cap=500):
    instructions = TOPICS_INSTRUCTIONS + (f"\n- {STRICT_LINE}" if strict else "")
    body, _ = topic_items(payload, desc_cap)
    return Prompt(instructions, "Tabs (index | title | address | what the page says):\n" + body + "\n")
