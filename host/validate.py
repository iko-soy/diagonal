"""Post-validation of model replies (sections 6, 8 and 12). Repairs what it can, rejects the rest."""
import os
import re
import zlib
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.realpath(__file__))
COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]
BANNED_WORDS = {"tab", "tabs", "group", "groups", "misc", "various", "stuff"}
QUOTES = "\"'“”‘’«»`"
TRAILING_PUNCT = re.compile(r"[\s.,;:!?…\-–—。、，！？：；]+$")


class ValidationError(Exception):
    pass


def _load_emoji():
    categories = {}
    with open(os.path.join(HERE, "emoji.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, rest = line.split(":", 1)
            categories[name.strip()] = rest.split()
    return categories


CATEGORIES = _load_emoji()


def _norm(e):
    return str(e).replace("️", "").strip()


CANONICAL = {_norm(e): e for emojis in CATEGORIES.values() for e in emojis}


def all_emoji():
    return list(CANONICAL.values())


def canonical_emoji(e):
    return CANONICAL.get(_norm(e)) if isinstance(e, str) else None


# Majority-host fallback for an emoji outside the list: a small map of well-known sites.
DOMAIN_CATEGORY = {
    "technology": ["github.com", "gitlab.com", "stackoverflow.com", "stackexchange.com", "npmjs.com", "pypi.org", "crates.io",
                   "docs.rs", "rust-lang.org", "python.org", "developer.mozilla.org", "developer.apple.com", "developer.chrome.com",
                   "news.ycombinator.com", "vercel.com", "cloudflare.com", "aws.amazon.com", "nixos.org", "kernel.org"],
    "reading": ["wikipedia.org", "medium.com", "substack.com", "nytimes.com", "theguardian.com", "bbc.co.uk", "bbc.com",
                "reuters.com", "arstechnica.com", "theverge.com", "goodreads.com"],
    "shopping": ["amazon.com", "amazon.co.uk", "amazon.de", "ebay.com", "etsy.com", "aliexpress.com", "bestbuy.com", "ikea.com"],
    "travel": ["booking.com", "airbnb.com", "expedia.com", "skyscanner.net", "tripadvisor.com", "maps.google.com", "kayak.com"],
    "media": ["youtube.com", "youtu.be", "netflix.com", "spotify.com", "twitch.tv", "vimeo.com", "soundcloud.com", "imdb.com"],
    "work": ["docs.google.com", "sheets.google.com", "notion.so", "figma.com", "slack.com", "linear.app", "atlassian.net",
             "trello.com", "asana.com", "calendar.google.com"],
    "finance": ["paypal.com", "stripe.com", "coinbase.com", "bloomberg.com", "finance.yahoo.com"],
    "science": ["arxiv.org", "nature.com", "sciencedirect.com", "pubmed.ncbi.nlm.nih.gov", "scholar.google.com"],
    "communication": ["mail.google.com", "outlook.live.com", "outlook.office.com", "web.whatsapp.com", "discord.com", "messenger.com"],
}
HOST_TO_CATEGORY = {h: c for c, hosts in DOMAIN_CATEGORY.items() for h in hosts}


def _host(url):
    try:
        return (urlsplit(str(url)).hostname or "").removeprefix("www.")
    except ValueError:
        return ""


def category_for_host(host):
    parts = host.split(".")
    for n in range(len(parts)):
        c = HOST_TO_CATEGORY.get(".".join(parts[n:]))
        if c:
            return c
    return "misc"


def default_emoji(items):
    hosts = [_host(it.get("url", "")) for it in items]
    hosts = [h for h in hosts if h]
    if not hosts:
        return CATEGORIES["misc"][0]
    majority = max(set(hosts), key=hosts.count)
    return CATEGORIES[category_for_host(majority)][0]


def repair_label(raw):
    """Trim, drop quotes, banned words and trailing punctuation, cap at 4 words / 28 chars, capitalise."""
    if not isinstance(raw, str):
        return None
    s = raw.translate({ord(q): None for q in QUOTES})
    s = TRAILING_PUNCT.sub("", " ".join(s.split()))
    words = [w for w in s.split(" ") if w and re.sub(r"[^\w]", "", w.lower()) not in BANNED_WORDS]
    words = words[:4]
    while len(words) > 2 and len(" ".join(words)) > 28:
        words.pop()
    label = TRAILING_PUNCT.sub("", " ".join(words))
    if not label:
        return None
    label = label[0].upper() + label[1:]
    return label if is_valid_label(label) else None


# Chinese and Japanese titles have no spaces between words, so they're checked by length instead.
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]")


def is_valid_label(label):
    words = label.split()
    cjk = len(CJK.findall(label)) * 2 > len(label.replace(" ", ""))
    return (
        (2 <= len(label) <= 16 if cjk else 3 <= len(label) <= 28)
        and (1 <= len(words) <= 4 if cjk else 2 <= len(words) <= 4)
        and not any(q in label for q in QUOTES)
        and not TRAILING_PUNCT.search(label)
        and not any(w.lower() in BANNED_WORDS for w in words)
    )


def validate_name(out, payload):
    if not isinstance(out, dict):
        raise ValidationError("reply is not an object")
    label = repair_label(out.get("title"))
    if not label:
        raise ValidationError(f"title {out.get('title')!r} breaks the label rules")
    emoji = canonical_emoji(out.get("emoji")) or default_emoji(payload.get("items", []))
    return {"title": label, "emoji": emoji}


def _color_for(label):
    choices = [c for c in COLORS if c != "grey"]
    return choices[zlib.crc32(label.encode("utf-8")) % len(choices)]


def validate_organize(out, payload):
    """Every index in range and used once; `existing` in range; colours from the fixed set;
    new groups under the minimum size or past maxGroups folded into leftovers; missing indexes appended."""
    if not isinstance(out, dict):
        raise ValidationError("reply is not an object")
    items = payload.get("items", [])
    n_items = len(items)
    n_existing = len(payload.get("existingGroups") or [])
    min_size = max(2, int(payload.get("minGroupSize", 2) or 2))
    max_groups = max(1, int(payload.get("maxGroups", 8) or 8))
    raw_groups = out.get("groups")
    if not isinstance(raw_groups, list):
        raise ValidationError("groups is not a list")

    used = set()
    joins, new = [], []
    for g in raw_groups:
        if not isinstance(g, dict):
            continue
        members = []
        for i in g.get("members") or []:
            if isinstance(i, bool) or not isinstance(i, int):
                continue
            if 0 <= i < n_items and i not in used:
                used.add(i)
                members.append(i)
        if not members:
            continue
        ex = g.get("existing")
        if isinstance(ex, list):  # fm has returned the optional integer as [] or [n]
            ex = ex[0] if len(ex) == 1 else None
        if isinstance(ex, int) and not isinstance(ex, bool) and 0 <= ex < n_existing:
            # Two topics can both point at one group (its example tabs got different topics): one join each.
            join = next((j for j in joins if j["existing"] == ex), None)
            if join:
                join["members"].extend(members)
            else:
                joins.append({"title": "", "emoji": "", "color": "", "existing": ex, "members": members})
            continue
        new.append((members, g))

    leftovers = []
    new.sort(key=lambda mg: -len(mg[0]))
    groups = list(joins)
    for k, (members, g) in enumerate(new):
        if len(members) < min_size or k >= max_groups:
            leftovers.extend(members)
            continue
        label = repair_label(g.get("title")) or ""  # "" = the extension names it through the naming loop
        member_items = [items[i] for i in members]
        emoji = canonical_emoji(g.get("emoji")) or default_emoji(member_items)
        color = g.get("color") if g.get("color") in COLORS else _color_for(label or str(members))
        groups.append({"title": label, "emoji": emoji, "color": color, "members": members})

    for i in out.get("leftovers") or []:
        if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < n_items and i not in used:
            used.add(i)
            leftovers.append(i)
    leftovers.extend(i for i in range(n_items) if i not in used and i not in leftovers)
    return {"groups": groups, "leftovers": sorted(set(leftovers))}


VAGUE_TOPICS = {"other", "others", "misc", "miscellaneous", "general", "various", "unknown", "none", "n/a", "-"}


def _norm_topic(t):
    t = " ".join(str(t or "").split()).strip(" .,:;!?\"'").casefold()
    return "" if t in VAGUE_TOPICS else t


def organize_from_topics(out, payload, owner):
    """Tabs that share a topic form a group. A topic that an existing group's example tabs have joins that
    group; others become new groups (titled later by the naming loop) or leftovers when too small.
    `owner` maps the example tabs' indexes to their group number (prompts.topic_items)."""
    if not isinstance(out, dict) or not isinstance(out.get("tabs"), list):
        raise ValidationError("tabs is not a list")
    n_items = len(payload.get("items", []))
    tab_topic, group_votes = {}, {}
    for t in out["tabs"]:
        if not isinstance(t, dict):
            continue
        i, topic = t.get("index"), _norm_topic(t.get("topic"))
        if isinstance(i, bool) or not isinstance(i, int) or not topic:
            continue
        if 0 <= i < n_items:
            tab_topic.setdefault(i, topic)
        elif i in owner:
            votes = group_votes.setdefault(topic, {})
            votes[owner[i]] = votes.get(owner[i], 0) + 1
    if not tab_topic:
        raise ValidationError("no tab got a topic")
    clusters = {}
    for i in sorted(tab_topic):
        clusters.setdefault(tab_topic[i], []).append(i)
    groups = []
    for topic, members in clusters.items():
        votes = group_votes.get(topic)
        if votes:
            g = max(sorted(votes), key=lambda k: votes[k])
            groups.append({"existing": g, "members": members})
        else:
            groups.append({"title": "", "emoji": "", "color": "", "members": members})
    return validate_organize({"groups": groups, "leftovers": []}, payload)
