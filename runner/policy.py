#!/usr/bin/env python3
"""Validate and normalise a repository's maintainer-agent policy file.

    policy.py < maintainer-agent.yml > policy.json      (empty stdin = defaults)

Exit 0 with normalised JSON on stdout, or exit 1 with the errors on stderr.
Runs with --network none: the policy comes from the watched repository and is
only as trustworthy as that repository's default branch. It can tailor the
agent's behaviour but never weaken the server's guarantees:

- unknown keys are errors (typos must not silently disable something);
- paths must be relative, without `..`;
- egress hosts must be plain host names (optionally with `*` inside one DNS
  label); they only apply to the fix agent;
- link prefixes must be https URLs;
- the policy files themselves are always protected (the server adds the
  forge's own automation paths, e.g. `.github/**`);
- numeric limits are clamped to host maxima passed in the environment
  (MAX_STEP_LIMIT, MAX_ATTEMPTS_CAP); the server clamps them again.

Versions: `version: 2` is current. `version: 1` files (maintainer-agent
v0.1) are still accepted: `triage` maps to `answer`, `playbooks.triage` to
`playbooks.issue`; `playbooks.ci-fix`, `bot_branches`, `bot_authors` and
`triage.max_age_days` are accepted and ignored.

A tiny YAML subset parser is included so the runner needs no PyYAML: maps,
lists (block `- x` and flow `[a, b]`), quoted/unquoted scalars, booleans,
integers and comments. Anything else is rejected.
"""

from __future__ import annotations

import json
import os
import re
import sys

MAX_STEP_LIMIT = int(os.environ.get("MAX_STEP_LIMIT", "120"))
MAX_ATTEMPTS_CAP = int(os.environ.get("MAX_ATTEMPTS_CAP", "5"))
POLICY_FILES = [".maintainer-agent.yml", ".github/maintainer-agent.yml", ".gitlab/maintainer-agent.yml"]

DEFAULTS = {
    "instructions": [],          # empty = first of AGENTS.md, CONTRIBUTING.md, README.md that exists
    "playbooks": {"issue": "", "implement": "", "review": ""},  # empty = generic playbook
    "checks": [],
    "egress": [],
    "links": [],
    "protected_paths": [],
    "answer": {"enabled": True, "max_attempts": 2},
    "fix": {"enabled": True, "trigger": "maintainers", "max_attempts": 2, "step_limit": 80},
    "review": {"enabled": True, "max_comments": 20,
               "max_diff_lines": 5000, "max_attempts": 2},
}
TOP_KEYS = {"version", "instructions", "playbooks", "checks", "egress", "links", "protected_paths",
            "answer", "fix", "review"}
V1_ONLY_KEYS = {"triage", "bot_branches", "bot_authors"}
ALWAYS_PROTECTED = POLICY_FILES


class PolicyError(Exception):
    pass


# --------------------------------------------------------------------------- YAML subset
def _scalar(tok: str, where: str):
    tok = tok.strip()
    if tok == "":
        return None
    if tok[0] in "\"'":
        q = tok[0]
        if len(tok) < 2 or tok[-1] != q:
            raise PolicyError(f"{where}: unterminated string")
        body = tok[1:-1]
        return body.replace("\\\"", "\"").replace("\\\\", "\\") if q == '"' else body.replace("''", "'")
    if tok[0] in "&*!|>{%@`":
        raise PolicyError(f"{where}: unsupported YAML syntax {tok[0]!r}")
    if tok in ("true", "True", "yes"):
        return True
    if tok in ("false", "False", "no"):
        return False
    if re.fullmatch(r"-?\d+", tok):
        return int(tok)
    return tok


def _strip_comment(line: str) -> str:
    out, q = [], None
    for i, c in enumerate(line):
        if q:
            if c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(c)
    return "".join(out).rstrip()


def _flow_list(tok: str, where: str):
    inner = tok.strip()[1:-1].strip()
    if not inner:
        return []
    items, cur, q = [], [], None
    for c in inner:
        if q:
            cur.append(c)
            if c == q:
                q = None
        elif c in "\"'":
            q = c
            cur.append(c)
        elif c == ",":
            items.append("".join(cur))
            cur = []
        elif c in "[]{}":
            raise PolicyError(f"{where}: nested flow collections are not supported")
        else:
            cur.append(c)
    items.append("".join(cur))
    return [_scalar(i, where) for i in items]


def parse_yaml(text: str):
    lines = []
    for n, raw in enumerate(text.splitlines(), 1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise PolicyError(f"line {n}: tabs are not allowed for indentation")
        s = _strip_comment(raw)
        if s.strip() in ("", "---"):
            continue
        lines.append((n, len(s) - len(s.lstrip(" ")), s.strip()))

    pos = 0

    def value_of(tok: str, where: str):
        tok = tok.strip()
        if tok.startswith("["):
            if not tok.endswith("]"):
                raise PolicyError(f"{where}: unterminated flow list")
            return _flow_list(tok, where)
        if tok.startswith("{"):
            if tok == "{}":
                return {}
            raise PolicyError(f"{where}: flow maps are not supported (use block style)")
        return _scalar(tok, where)

    def block(indent: int):
        nonlocal pos
        if pos >= len(lines):
            return None
        is_list = lines[pos][2].startswith("- ") or lines[pos][2] == "-"
        result = [] if is_list else {}
        while pos < len(lines):
            n, ind, s = lines[pos]
            if ind < indent:
                break
            if ind > indent:
                raise PolicyError(f"line {n}: unexpected indentation")
            where = f"line {n}"
            if is_list:
                if not (s.startswith("- ") or s == "-"):
                    raise PolicyError(f"{where}: expected a list item")
                pos += 1
                item = s[1:].strip()
                if item == "":
                    result.append(block(lines[pos][1]) if pos < len(lines) and lines[pos][1] > indent else None)
                elif re.match(r"^[A-Za-z0-9_-]+:(\s|$)", item):
                    raise PolicyError(f"{where}: maps inside lists are not supported")
                else:
                    result.append(value_of(item, where))
            else:
                m = re.match(r"^([A-Za-z0-9_-]+):(?:\s+(.*))?$", s)
                if not m:
                    raise PolicyError(f"{where}: expected 'key: value'")
                key, rest = m.group(1), (m.group(2) or "").strip()
                if key in result:
                    raise PolicyError(f"{where}: duplicate key {key!r}")
                pos += 1
                if rest == "":
                    child_indent = lines[pos][1] if pos < len(lines) else -1
                    if pos < len(lines) and (child_indent > indent or
                                             (child_indent == indent and lines[pos][2].startswith("- "))):
                        result[key] = block(child_indent)
                    else:
                        result[key] = None
                else:
                    result[key] = value_of(rest, where)
        return result

    doc = block(0) if lines else {}
    if pos != len(lines):
        raise PolicyError(f"line {lines[pos][0]}: could not parse")
    return doc if doc is not None else {}


# --------------------------------------------------------------------------- validation
REL_PATH = re.compile(r"^(?!/)(?!.*(^|/)\.\.(/|$))[A-Za-z0-9._/*@+-]+$")
HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9*]([a-z0-9*-]{0,61}[a-z0-9*])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
BRANCH_GLOB = re.compile(r"^[A-Za-z0-9._/*-]+$")
EMAIL = re.compile(r"^[^\s@<>]+@[^\s@<>]+$")


def _wildcard_ok(host: str) -> bool:
    """`*` only in the first label, followed by at least two plain labels
    (`*.example.org`, `foo*.blob.core.windows.net`). `*.com` is refused, and
    so is `*.co.uk`: when the label before the top-level domain is short
    (co, com, org, ac...), three plain labels are required."""
    labels = host.split(".")
    if any("*" in label for label in labels[1:]):
        return False
    if "*" not in labels[0]:
        return True
    rest = labels[1:]
    if len(rest) < 2:
        return False
    return len(rest) >= 3 or len(rest[0]) > 3


def _str_list(v, key, errors, pattern=None, what="value", limit=50):
    if v is None:
        return []
    if not isinstance(v, list):
        errors.append(f"{key}: must be a list")
        return []
    out = []
    for item in v[:limit]:
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{key}: every item must be a non-empty string")
            continue
        item = item.strip()
        if pattern and not pattern.fullmatch(item):
            errors.append(f"{key}: invalid {what} {item!r}")
            continue
        out.append(item)
    if len(v) > limit:
        errors.append(f"{key}: at most {limit} items")
    return out


def _clamp_int(v, key, lo, hi, default, errors):
    if v is None:
        return default
    if not isinstance(v, int) or isinstance(v, bool):
        errors.append(f"{key}: must be an integer")
        return default
    return max(lo, min(hi, v))


def _bool(v, key, default, errors):
    if v is None:
        return default
    if not isinstance(v, bool):
        errors.append(f"{key}: must be true or false")
        return default
    return v


def _section(doc, key, fields, errors):
    sect = doc.get(key)
    if sect is None:
        return {}
    if not isinstance(sect, dict):
        errors.append(f"{key}: must be a map")
        return {}
    for k in set(sect) - set(fields):
        errors.append(f"{key}: unknown key {k!r}")
    return sect


def normalise(doc) -> dict:
    errors: list[str] = []
    if not isinstance(doc, dict):
        raise PolicyError("the policy must be a YAML map")
    version = doc.get("version", 2)
    if version not in (1, 2):
        errors.append("version: only 1 and 2 are supported")
    allowed = TOP_KEYS | (V1_ONLY_KEYS if version == 1 else set())
    unknown = set(doc) - allowed
    if unknown:
        errors.append(f"unknown keys: {', '.join(sorted(unknown))}")

    p = json.loads(json.dumps(DEFAULTS))
    p["instructions"] = _str_list(doc.get("instructions"), "instructions", errors, REL_PATH, "path", 10)

    pb = doc.get("playbooks") or {}
    if not isinstance(pb, dict):
        errors.append("playbooks: must be a map")
        pb = {}
    names = {"issue": "issue", "implement": "implement", "review": "review"}
    if version == 1:
        names = {"triage": "issue", "implement": "implement", "ci-fix": None}
    for k in set(pb) - set(names):
        errors.append(f"playbooks: unknown key {k!r}")
    for k, target in names.items():
        v = pb.get(k)
        if v is None:
            continue
        if not isinstance(v, str) or not REL_PATH.fullmatch(v) or "*" in v:
            errors.append(f"playbooks.{k}: must be a relative file path")
        elif target:
            p["playbooks"][target] = v

    checks = _str_list(doc.get("checks"), "checks", errors, limit=10)
    for c in checks:
        if len(c) > 300 or "\n" in c:
            errors.append(f"checks: command too long or multi-line: {c[:40]!r}")
    p["checks"] = [c for c in checks if len(c) <= 300]
    p["egress"] = [h.lower() for h in _str_list(doc.get("egress"), "egress", errors, limit=50)
                   if (HOST.fullmatch(h.lower()) and _wildcard_ok(h.lower()))
                   or errors.append(f"egress: invalid host {h!r} (a label with * needs at least two plain labels after it)")]
    p["links"] = [u for u in _str_list(doc.get("links"), "links", errors, limit=20)
                  if re.fullmatch(r"https://[A-Za-z0-9.-]+(/[^\s<>()\[\]`]*)?", u)
                  or errors.append(f"links: must be an https URL prefix: {u!r}")]
    protected = _str_list(doc.get("protected_paths"), "protected_paths", errors, REL_PATH, "path glob", 50)
    p["protected_paths"] = sorted(set(protected) | set(ALWAYS_PROTECTED))

    if version == 1:
        _str_list(doc.get("bot_branches"), "bot_branches", errors, BRANCH_GLOB, "branch glob", 10)
        _str_list(doc.get("bot_authors"), "bot_authors", errors, EMAIL, "email", 10)
        answer = _section(doc, "triage", ("enabled", "max_age_days", "max_attempts"), errors)
        if "answer" in doc:
            errors.append("answer: use either triage (version 1) or answer (version 2)")
    else:
        answer = _section(doc, "answer", ("enabled", "max_attempts"), errors)
    p["answer"]["enabled"] = _bool(answer.get("enabled"), "answer.enabled", True, errors)
    p["answer"]["max_attempts"] = _clamp_int(answer.get("max_attempts"), "answer.max_attempts", 1, MAX_ATTEMPTS_CAP, 2, errors)

    fix = _section(doc, "fix", ("enabled", "trigger", "max_attempts", "step_limit"), errors)
    p["fix"]["enabled"] = _bool(fix.get("enabled"), "fix.enabled", True, errors)
    trigger = fix.get("trigger", "maintainers")
    if trigger not in ("maintainers", "label"):
        errors.append("fix.trigger: must be maintainers or label")
    else:
        p["fix"]["trigger"] = trigger
    p["fix"]["max_attempts"] = _clamp_int(fix.get("max_attempts"), "fix.max_attempts", 1, MAX_ATTEMPTS_CAP, 2, errors)
    p["fix"]["step_limit"] = _clamp_int(fix.get("step_limit"), "fix.step_limit", 10, MAX_STEP_LIMIT, 80, errors)

    review = _section(doc, "review", ("enabled", "max_comments", "max_diff_lines", "max_attempts"), errors)
    p["review"]["enabled"] = _bool(review.get("enabled"), "review.enabled", True, errors)
    p["review"]["max_comments"] = _clamp_int(review.get("max_comments"), "review.max_comments", 0, 100, 20, errors)
    p["review"]["max_diff_lines"] = _clamp_int(review.get("max_diff_lines"), "review.max_diff_lines", 100, 100000, 5000, errors)
    p["review"]["max_attempts"] = _clamp_int(review.get("max_attempts"), "review.max_attempts", 1, MAX_ATTEMPTS_CAP, 2, errors)

    if errors:
        raise PolicyError("\n".join(errors))
    return p


def main() -> int:
    raw = sys.stdin.read(65536)
    try:
        doc = parse_yaml(raw) if raw.strip() else {}
        policy = normalise(doc)
    except PolicyError as e:
        for line in str(e).splitlines():
            print(f"policy error: {line}", file=sys.stderr)
        return 1
    json.dump(policy, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
