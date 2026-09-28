#!/usr/bin/env python3
"""Sanitise agent-written Markdown before it is posted to GitHub.

    sanitize.py < draft.md > safe.md

Exit status: 0 = safe to post (sanitised text on stdout)
             3 = HOLD: do not post; a human should look (reasons on stderr,
                 sanitised text still on stdout for the run directory)
             2 = usage / internal error

The model that wrote the draft may have read attacker-controlled text (issue
bodies, comments, CI logs, upstream release notes), so the draft is treated as
untrusted output. What this removes or neutralises, and why:

- HTML comments, anywhere (also in code): the dispatcher and the workflows use
  `<!-- agent... -->` markers as control state, so the draft must not forge them.
- Images, raw HTML and non-allow-listed links: GitHub fetches images when the
  comment is rendered (an image URL is a zero-click exfiltration channel), and
  links to arbitrary sites are a phishing/exfiltration vector. Allow-listed
  links (this repository by default) stay clickable; others become inert text.
- @mentions and cross-repository references (`owner/repo#1`): no pings, no
  backlink spam in other repositories.
- Invisible Unicode (zero-width, bidi overrides, Unicode "tag" characters used
  for ASCII smuggling).
- Credential-shaped strings are redacted, and their presence forces a HOLD.

HOLD (exit 3) when the draft is suspicious: a credential was redacted, it is
too long, or it carries long encoded blobs (base64 / hex / percent-encoding),
which have no place in a first answer and are the usual shape of exfiltrated
data.

Configuration (environment):
  REPO                          owner/name whose github.com URLs are allowed (required)
  SANITIZE_EXTRA_LINK_PREFIXES  space-separated extra allowed https URL prefixes
                                (the repository policy's `links`)
  SANITIZE_MAX_CHARS            hold above this length (default 12000)
"""

from __future__ import annotations

import os
import re
import sys

REPO = os.environ.get("REPO", "")
EXTRA_PREFIXES = [p for p in os.environ.get("SANITIZE_EXTRA_LINK_PREFIXES", "").split()
                  if p.startswith("https://") and len(p) > len("https://x.y")]
MAX_CHARS = int(os.environ.get("SANITIZE_MAX_CHARS", "12000"))

# Formatting-only tags that are kept when they carry no attributes.
SAFE_TAGS = {"details", "summary", "sub", "sup", "br", "b", "i", "em", "strong", "code", "kbd", "p"}

INVISIBLE = re.compile(
    "[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff"
    "\U000e0000-\U000e007f]"
)
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

SECRETS = [
    re.compile(r"\b(gh[pousr]_)[A-Za-z0-9]{20,}"),
    re.compile(r"\b(github_pat_)\w{20,}"),
    re.compile(r"\b(dckr_pat_)[\w-]{10,}"),
    re.compile(r"\b(glpat-)[\w-]{15,}"),
    re.compile(r"\b(sk-)[A-Za-z0-9_-]{20,}"),
    re.compile(r"\b(xox[abposr]-)[\w-]{10,}"),
    re.compile(r"\b(hf_)[A-Za-z0-9]{30,}"),
    re.compile(r"\b(AKIA)[0-9A-Z]{16}\b"),
    re.compile(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
]

B64_BLOB = re.compile(r"[A-Za-z0-9+/_-]{120,}={0,2}")
HEX_BLOB = re.compile(r"\b[0-9a-fA-F]{129,}\b")  # sha512 (128) is the longest legit digest
PCT_BLOB = re.compile(r"(?:%[0-9A-Fa-f]{2}){30,}")

FENCE = re.compile(r"^[ ]{0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"(`+)(.+?)\1", re.S)
IMAGE_INLINE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
IMAGE_REF = re.compile(r"!\[([^\]]*)\]\[[^\]]*\]")
LINK_INLINE = re.compile(r"\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)")
LINK_DEF = re.compile(r"^[ ]{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s.*)?$", re.M)
AUTOLINK = re.compile(r"<((?:https?|ftp)://[^>\s]+|mailto:[^>\s]+)>")
HTML_TAG = re.compile(r"</?([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?)/?>")
BARE_URL = re.compile(r"(?:(?:https?|ftp)://|www\.)[^\s<>()\[\]`]+", re.I)
MENTION = re.compile(r"(^|[^\w`/.])@([A-Za-z0-9][A-Za-z0-9-]*(?:/[A-Za-z0-9_.-]+)?)")
XREF = re.compile(r"(?<![\w`/.])([A-Za-z0-9][\w.-]*/[\w.-]+#\d+)\b")

reasons: list[str] = []


def allowed(url: str) -> bool:
    base = f"https://github.com/{REPO}"
    if url == base or url.startswith((base + "/", base + "#", base + "?")):
        return True
    if url.startswith("#"):  # in-page anchor
        return True
    return any(url.startswith(p) for p in EXTRA_PREFIXES)


def inert(url: str) -> str:
    url = url.replace("`", "")
    if len(url) > 100:
        url = url[:100] + "…"
    return f"`{url}`"


def clean_prose(text: str) -> str:
    placeholders: list[str] = []

    def keep(s: str) -> str:
        placeholders.append(s)
        return f"\x00{len(placeholders) - 1}\x00"

    text = IMAGE_INLINE.sub(lambda m: f"[image removed{': ' + m.group(1) if m.group(1) else ''}]", text)
    text = IMAGE_REF.sub(lambda m: f"[image removed{': ' + m.group(1) if m.group(1) else ''}]", text)
    text = LINK_DEF.sub(lambda m: keep(m.group(0)) if allowed(m.group(1)) else "", text)
    text = AUTOLINK.sub(lambda m: keep(f"<{m.group(1)}>") if allowed(m.group(1)) else keep(inert(m.group(1))), text)
    text = LINK_INLINE.sub(
        lambda m: keep(m.group(0)) if allowed(m.group(2))
        else f"{m.group(1)} (link removed: {keep(inert(m.group(2)))})",
        text,
    )

    def tag(m: re.Match) -> str:
        name, attrs = m.group(1).lower(), m.group(2).strip()
        return m.group(0) if name in SAFE_TAGS and not attrs else ""

    text = HTML_TAG.sub(tag, text)
    text = BARE_URL.sub(lambda m: keep(m.group(0) if allowed(m.group(0)) else inert(m.group(0))), text)
    text = MENTION.sub(lambda m: f"{m.group(1)}`@{m.group(2)}`", text)
    text = XREF.sub(lambda m: f"`{m.group(1)}`", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: placeholders[int(m.group(1))], text)


def clean_block(prose: str) -> str:
    """Prose outside fences: keep inline code spans verbatim, clean the rest."""
    out, pos = [], 0
    for m in INLINE_CODE.finditer(prose):
        out.append(clean_prose(prose[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(clean_prose(prose[pos:]))
    return "".join(out)


def sanitize(text: str) -> str:
    text = INVISIBLE.sub("", text)
    text = CONTROL.sub("", text)
    # Control markers must not survive anywhere, code blocks included.
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = text.replace("<!--", "<! --")

    for pat in SECRETS:
        text, n = pat.subn(lambda m: f"{m.group(1)}[redacted]", text)
        if n:
            reasons.append(f"credential-shaped string redacted ({pat.pattern[:24]}…)")

    # Split into fenced code blocks (kept verbatim; GitHub renders nothing in
    # them) and prose (cleaned). An unclosed fence runs to the end, as on GitHub.
    lines = text.splitlines(keepends=True)
    out, buf, fence = [], [], None
    for line in lines:
        m = FENCE.match(line)
        if fence is None and m:
            out.append(clean_block("".join(buf)))
            buf, fence = [line], m.group(1)
        elif fence is not None and m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) \
                and not line.strip()[len(m.group(1)):].strip():
            buf.append(line)
            out.append("".join(buf))
            buf, fence = [], None
        else:
            buf.append(line)
    out.append("".join(buf) if fence is not None else clean_block("".join(buf)))
    text = "".join(out).strip() + "\n"

    if len(text) > MAX_CHARS:
        reasons.append(f"too long ({len(text)} > {MAX_CHARS} chars)")
    for blob in B64_BLOB.findall(text):
        if not re.fullmatch(r"[0-9a-fA-F]+", blob):
            reasons.append(f"long encoded blob ({len(blob)} chars)")
            break
    if HEX_BLOB.search(text):
        reasons.append("long hex blob")
    if PCT_BLOB.search(text):
        reasons.append("long percent-encoded blob")
    if not text.strip():
        reasons.append("empty after sanitising")
    return text


def main() -> int:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", REPO):
        print("sanitize.py: REPO=owner/name is required", file=sys.stderr)
        return 2
    if len(sys.argv) > 1:
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        return 2
    raw = sys.stdin.buffer.read(1_000_000).decode("utf-8", errors="replace")
    sys.stdout.write(sanitize(raw))
    for r in reasons:
        print(f"HOLD: {r}", file=sys.stderr)
    return 3 if reasons else 0


if __name__ == "__main__":
    sys.exit(main())
