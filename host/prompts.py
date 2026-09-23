"""Section 9 prompt templates. Pure functions: payload in, prompt text out."""
from urllib.parse import urlsplit

from validate import COLORS, all_emoji

EMOJI_LIST = " ".join(all_emoji())
STRICT_LINE = "Reply with only the object, nothing before or after it."


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


def render_items(items):
    lines = []
    for it in items:
        desc = _clean(it.get("description"), 300) or "-"
        lines.append(f"{it['i']} | {_clean(it.get('title'), 120)} | {render_address(it.get('url', ''))} | {desc}")
    return "\n".join(lines)


def _quoted(titles):
    return ", ".join(f'"{_clean(t, 60)}"' for t in titles)


def build_name_prompt(payload, strict=False):
    rules = [
        "- Title: 2 to 4 words, sentence case, no punctuation at the end, no quotes.",
        "- Describe the topic or task, not the website, unless every tab is the same site.",
        "- Never use the words tab, tabs, group, misc, various, stuff.",
        "- Write the title in the language most tab titles use.",
        f"- Emoji: exactly one, chosen from this list: {EMOJI_LIST}",
    ]
    current = payload.get("currentTitle")
    if current:
        rules.append(f'- Current title: "{_clean(current, 60)}". Keep it exactly if it still fits; change it only if the tabs have clearly moved on.')
    siblings = payload.get("siblingTitles") or []
    if siblings:
        rules.append(f"- Other groups in this window are named: {_quoted(siblings)}. Do not reuse those names.")
    differ = payload.get("mustDifferFrom") or []
    if differ:
        rules.append(f"- The title must not be any of: {_quoted(differ)}.")
    if strict:
        rules.append(f"- {STRICT_LINE}")
    return (
        "You name a browser tab group. Reply with a title and one emoji that describe what these tabs have in common.\n\n"
        "Rules:\n" + "\n".join(rules) + "\n\n"
        "Tabs (index | title | address | description):\n" + render_items(payload["items"]) + "\n"
    )


def _organize_rules(max_groups, strict):
    rules = [
        "- Put each tab index into exactly one group, or into leftovers if it fits nowhere.",
        f"- A group needs at least 2 tabs. Prefer fewer, broader groups; at most {max_groups} new groups.",
        '- Reuse an existing group when a tab fits it: set "existing" to that group\'s number and leave title, emoji and color empty.',
        f"- New groups: title of 2 to 4 words in sentence case, one emoji from: {EMOJI_LIST}, one color from: {', '.join(COLORS)}.",
        "- Group by topic or task, not by website, unless the tabs are the same site and nothing else links them.",
        "- Write titles in the language most tab titles use.",
    ]
    if strict:
        rules.append(f"- {STRICT_LINE}")
    return rules


def _existing_block(existing):
    if not existing:
        return ""
    lines = [f"{g['g']} | {_clean(g.get('title'), 60)} | {'; '.join(_clean(s, 60) for s in (g.get('samples') or [])[:2]) or '-'}" for g in existing]
    return "Existing groups (number | title | examples):\n" + "\n".join(lines) + "\n\n"


def build_organize_prompt(payload, strict=False):
    return (
        "You sort browser tabs into topic groups.\n\n"
        "Rules:\n" + "\n".join(_organize_rules(payload.get("maxGroups", 8), strict)) + "\n\n"
        + _existing_block(payload.get("existingGroups") or [])
        + "Tabs (index | title | address | description):\n" + render_items(payload["items"]) + "\n"
    )


# Two-call fallback (section 8) for an `fm schema` that cannot nest arrays of objects.

def build_labels_prompt(payload, strict=False):
    rules = [
        f"- Propose at most {payload.get('maxGroups', 8)} new topic groups for tabs that do not fit an existing group.",
        "- Each needs a label of 2 to 4 words in sentence case, one emoji and one color, at the same position in labels, emojis and colors.",
        f"- Emoji from: {EMOJI_LIST}",
        f"- Color from: {', '.join(COLORS)}.",
        "- Group by topic or task, not by website. Write labels in the language most tab titles use.",
    ]
    if strict:
        rules.append(f"- {STRICT_LINE}")
    return (
        "You plan topic groups for browser tabs.\n\nRules:\n" + "\n".join(rules) + "\n\n"
        + _existing_block(payload.get("existingGroups") or [])
        + "Tabs (index | title | address | description):\n" + render_items(payload["items"]) + "\n"
    )


def build_assign_prompt(payload, labels, strict=False):
    existing = payload.get("existingGroups") or []
    options = [f"{n} | {_clean(g.get('title'), 60)}" for n, g in enumerate(existing)]
    options += [f"{len(existing) + n} | {_clean(label, 60)}" for n, label in enumerate(labels)]
    rules = [
        f"- assignment has exactly {len(payload['items'])} numbers, one per tab in index order.",
        "- Each number is the group that tab belongs to, or -1 if it fits none.",
    ]
    if strict:
        rules.append(f"- {STRICT_LINE}")
    return (
        "You assign browser tabs to groups.\n\nRules:\n" + "\n".join(rules) + "\n\n"
        "Groups (number | title):\n" + "\n".join(options) + "\n\n"
        "Tabs (index | title | address | description):\n" + render_items(payload["items"]) + "\n"
    )
