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


rc, p, _ = run("")
check("empty policy = defaults", rc == 0 and p["triage"]["enabled"] and p["fix"]["step_limit"] == 80)
check("defaults protect .github", ".github/**" in p["protected_paths"] and ".github/maintainer-agent.yml" in p["protected_paths"])
check("defaults: no bot branches", p["bot_branches"] == [] and p["egress"] == [] and p["links"] == [])

full = open(os.path.join(HERE, "..", "templates", "maintainer-agent.yml")).read()
rc, p, err = run(full)
check("template parses", rc == 0)

rc, p, _ = run("""
instructions: [AGENTS.md, docs/CONTRIBUTING.md]
playbooks:
  triage: docs/agent/triage.md
checks:
  - make test   # comment
  - "npm run lint"
egress:
  - registry.npmjs.org
  - 'productionresultssa*.blob.core.windows.net'
links: [https://example.com/docs/]
protected_paths: [Dockerfile]
bot_branches: [renovate/*, dependabot/*]
bot_authors: ["29139614+renovate[bot]@users.noreply.github.com"]
triage:
  enabled: false
fix:
  max_attempts: 99
  step_limit: 5
""")
check("full policy parses", rc == 0)
check("lists kept in order", p["checks"] == ["make test", "npm run lint"])
check("egress kept", p["egress"] == ["registry.npmjs.org", "productionresultssa*.blob.core.windows.net"])
check("protected paths merged with the mandatory ones", p["protected_paths"] == [".github/**", ".github/maintainer-agent.yml", "Dockerfile"])
check("triage disabled", p["triage"]["enabled"] is False and p["triage"]["max_age_days"] == 14)
check("max_attempts clamped to cap", p["fix"]["max_attempts"] == 5)
check("step_limit clamped to minimum", p["fix"]["step_limit"] == 10)
rc, p, _ = run("fix:\n  step_limit: 500\n", MAX_STEP_LIMIT="60")
check("step_limit clamped to host max", p["fix"]["step_limit"] == 60)

bad = {
    "unknown top-level key": "egres: [a.com]\n",
    "unknown mode key": "fix:\n  enable: true\n",
    "absolute playbook": "playbooks:\n  triage: /etc/passwd\n",
    "dotdot playbook": "playbooks:\n  triage: docs/../../x.md\n",
    "unknown playbook": "playbooks:\n  deploy: x.md\n",
    "egress with path": "egress: [evil.com/x]\n",
    "egress with port": "egress: ['evil.com:22']\n",
    "egress bare word": "egress: [localhost]\n",
    "http link": "links: [http://example.com/]\n",
    "catch-all bot branch": "bot_branches: ['*']\n",
    "agent branch as bot": "bot_branches: [maintainer-agent/*]\n",
    "bad email": "bot_authors: [renovate]\n",
    "string where list": "checks: make test\n",
    "bool as int": "fix:\n  step_limit: true\n",
    "version 2": "version: 2\n",
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
