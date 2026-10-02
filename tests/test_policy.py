#!/usr/bin/env python3
"""Tests for runner/policy.py."""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY = os.path.join(HERE, "..", "runner", "policy.py")
failures = 0


def run(text: str, **env: str):
    p = subprocess.run([sys.executable, POLICY], input=text.encode(), capture_output=True,
                       env={**os.environ, **env})
    out = json.loads(p.stdout) if p.returncode == 0 else None
    return p.returncode, out, p.stderr.decode()


def check(name, cond):
    global failures
    print(("ok   " if cond else "FAIL ") + name)
    failures += not cond


POLICY_FILES = [".github/maintainer-agent.yml", ".gitlab/maintainer-agent.yml", ".maintainer-agent.yml"]

rc, p, _ = run("")
check("empty policy = defaults", rc == 0 and p["answer"]["enabled"] and p["fix"]["step_limit"] == 80)
check("defaults protect every policy file", p["protected_paths"] == POLICY_FILES)
check("defaults: automatic fixes for maintainers", p["fix"]["trigger"] == "maintainers")
check("defaults: reviews on", p["review"]["enabled"])
check("defaults: no egress or links", p["egress"] == [] and p["links"] == [])
check("output has exactly the keys the server expects",
      sorted(p) == ["answer", "checks", "egress", "fix", "instructions", "links", "playbooks", "protected_paths", "review"])

full = open(os.path.join(HERE, "..", "templates", "maintainer-agent.yml")).read()
rc, p, err = run(full)
check("template parses", rc == 0)

rc, p, _ = run("""
version: 2
instructions: [AGENTS.md, docs/CONTRIBUTING.md]
playbooks:
  issue: docs/agent/issue.md
  review: docs/agent/review.md
checks:
  - make test   # comment
  - "npm run lint"
egress:
  - registry.npmjs.org
  - 'productionresultssa*.blob.core.windows.net'
links: [https://example.com/docs/]
protected_paths: [Dockerfile]
answer:
  enabled: false
fix:
  trigger: label
  max_attempts: 99
  step_limit: 5
review:
  max_comments: 500
  max_diff_lines: 10
""")
check("full v2 policy parses", rc == 0)
check("lists kept in order", p["checks"] == ["make test", "npm run lint"])
rc2, p2, _ = run("egress: ['*.example.org', 'cdn*.example.org']\n")
check("narrow wildcards accepted", rc2 == 0 and p2["egress"] == ["*.example.org", "cdn*.example.org"])
rc3, p3, _ = run("egress: ['productionresultssa*.blob.core.windows.net', '*.example.co.uk']\n")
check("long wildcard hosts accepted", rc3 == 0)
check("egress kept", p["egress"] == ["registry.npmjs.org", "productionresultssa*.blob.core.windows.net"])
check("protected paths merged with the policy files", p["protected_paths"] == sorted(POLICY_FILES + ["Dockerfile"]))
check("playbooks", p["playbooks"] == {"issue": "docs/agent/issue.md", "implement": "", "review": "docs/agent/review.md"})
check("answers disabled", p["answer"]["enabled"] is False)
check("label-only fixes", p["fix"]["trigger"] == "label")
check("max_attempts clamped to cap", p["fix"]["max_attempts"] == 5)
check("step_limit clamped to minimum", p["fix"]["step_limit"] == 10)
check("review limits clamped", p["review"]["max_comments"] == 100 and p["review"]["max_diff_lines"] == 100)
rc, p, _ = run("fix:\n  step_limit: 500\n", MAX_STEP_LIMIT="60")
check("step_limit clamped to host max", p["fix"]["step_limit"] == 60)

# Version 1 (maintainer-agent v0.1) files keep working.
rc, p, err = run("""
version: 1
instructions: [AGENTS.md]
playbooks:
  triage: docs/agent/triage.md
  implement: docs/agent/implement-issue.md
  ci-fix: docs/agent/fix-ci-failure.md
checks: [scripts/check.sh]
bot_branches: [renovate/*]
bot_authors: ["29139614+renovate[bot]@users.noreply.github.com"]
triage:
  enabled: false
  max_age_days: 14
  max_attempts: 3
fix:
  enabled: true
  max_attempts: 2
  step_limit: 80
""")
check("v1 policy still accepted", rc == 0)
check("v1 triage maps to answer", p and p["answer"] == {"enabled": False, "max_attempts": 3})
check("v1 triage playbook maps to issue", p and p["playbooks"]["issue"] == "docs/agent/triage.md")
check("v1 ci-fix playbook ignored", p and "ci-fix" not in p["playbooks"])

bad = {
    "unknown top-level key": "egres: [a.com]\n",
    "unknown section key": "fix:\n  enable: true\n",
    "absolute playbook": "playbooks:\n  issue: /etc/passwd\n",
    "dotdot playbook": "playbooks:\n  issue: docs/../../x.md\n",
    "unknown playbook": "playbooks:\n  deploy: x.md\n",
    "v1 playbook name in v2": "playbooks:\n  triage: x.md\n",
    "v1-only key in v2": "bot_branches: [renovate/*]\n",
    "v1 triage section in v2": "triage:\n  enabled: true\n",
    "both triage and answer in v1": "version: 1\ntriage:\n  enabled: true\nanswer:\n  enabled: true\n",
    "unknown fix trigger": "fix:\n  trigger: always\n",
    "egress with path": "egress: [evil.com/x]\n",
    "egress with port": "egress: ['evil.com:22']\n",
    "egress bare word": "egress: [localhost]\n",
    "egress wildcard TLD": "egress: ['*.com']\n",
    "egress wildcard second-level": "egress: ['*.co.uk']\n",
    "egress wildcard prefix TLD": "egress: ['a*.com']\n",
    "egress wildcard ccTLD second level": "egress: ['a*.com.au']\n",
    "egress wildcard not first": "egress: ['a.*.example.org']\n",
    "http link": "links: [http://example.com/]\n",
    "v1 bad email": "version: 1\nbot_authors: [renovate]\n",
    "string where list": "checks: make test\n",
    "bool as int": "fix:\n  step_limit: true\n",
    "int as bool": "review:\n  enabled: 1\n",
    "version 3": "version: 3\n",
    "anchors": "checks: &a [x]\n",
    "flow map": "fix: {enabled: true}\n",
    "tabs": "fix:\n\tenabled: true\n",
    "duplicate key": "checks: [a]\nchecks: [b]\n",
    "multi-line check": "checks:\n  - |\n    rm -rf /\n",
    "not a map": "- a\n- b\n",
}
for name, text in bad.items():
    rc, _, err = run(text)
    check(f"rejects {name}", rc == 1 and "policy error" in err)

sys.exit(1 if failures else 0)
