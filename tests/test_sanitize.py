#!/usr/bin/env python3
"""Regression tests for runner/sanitize.py."""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SANITIZE = os.path.join(HERE, "..", "runner", "sanitize.py")
REPO = "example-org/example-repo"


def run(text: str, **env: str) -> tuple[int, str, str]:
    p = subprocess.run(
        [sys.executable, SANITIZE], input=text.encode(), capture_output=True,
        env={**os.environ, "REPO": REPO, **env},
    )
    return p.returncode, p.stdout.decode(), p.stderr.decode()


failures = 0


def check(name: str, cond: bool) -> None:
    global failures
    print(("ok   " if cond else "FAIL ") + name)
    failures += not cond


attack = open(os.path.join(HERE, "sanitize-attack.md"), encoding="utf-8").read()
rc, out, err = run(attack)
check("attack sample is held", rc == 3)
prose = out.split("```")[0::2]  # outside fenced blocks (inert there)
check("no clickable evil URL outside code",
      all("](https://evil" not in p and 'src="https://evil' not in p for p in prose))
check("no <img>", "<img" not in out)
check("no <a href>", "<a " not in out)
check("no control marker", "<!-- agent" not in out)
check("image removed", "[image removed: x]" in out)
check("mention neutralised", "`@someone`" in out)
check("cross-repo ref neutralised", "`other/repo#3`" in out)
check("same-repo #ref kept", " #12." in out)
check("allowed link kept", f"[good](https://github.com/{REPO}/blob/abc/Dockerfile#L1-L5)" in out)
check("disallowed link made inert", "bad (link removed: `https://evil.example/x`)" in out)
check("token redacted", "ghp_abcdef" not in out and "ghp_[redacted]" in out)
check("zero-width removed", "zero-width" in out)
check("reference definition to evil removed", "[ref]:" not in out)

rc, out, _ = run(f"fine answer, see [PR](https://github.com/{REPO}/pull/2) and #3.\n")
check("clean answer passes", rc == 0 and f"(https://github.com/{REPO}/pull/2)" in out)

rc, _, err = run("x " + "QUJD" * 60 + "\n")
check("base64 blob held", rc == 3 and "encoded blob" in err)
rc, _, _ = run("sha256 " + "a" * 64 + " ok\n")
check("sha256 digest allowed", rc == 0)
rc, _, _ = run("x " + "%41" * 40 + "\n")
check("percent-encoded blob held", rc == 3)
rc, _, _ = run("a" * 20 + "\n", SANITIZE_MAX_CHARS="10")
check("too long held", rc == 3)
rc, out, _ = run("look-alike https://github.com/" + REPO + ".evil.com/x\n")
check("look-alike host made inert", "`https://github.com/" + REPO + ".evil.com/x`" in out)
rc, out, _ = run("<details><summary>Log</summary>\n\nx\n</details>\n")
check("safe tags kept", rc == 0 and "<details><summary>Log</summary>" in out)
rc, out, _ = run("tag smuggling \U000e0041\U000e0042 end\n")
check("unicode tag characters removed", "\U000e0041" not in out)

sys.exit(1 if failures else 0)
