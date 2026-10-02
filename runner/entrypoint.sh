#!/usr/bin/env bash
# Container entrypoint. One image, several roles, all started by the
# maintainer-agent server (server/src/adapters/sandbox/docker):
#
#   issue-agent        answers an issue        (model; NO forge token; egress = model only)
#   fix-agent          proposes a change       (model; NO forge token; egress = model + policy hosts)
#   review-agent       reviews a change request (model; NO forge token; egress = model only)
#   publish            pushes a checked patch  (NO model; push token for one repo; egress = git hosts)
#   sanitize [--json]  cleans agent text       (--network none; exit 3 = hold in text mode)
#   policy             validates a policy file (--network none; stdin YAML -> stdout JSON)
#   egress             allow-list HTTP(S) proxy (tinyproxy) for the agents' internal network
set -euo pipefail

egress() {
  # EGRESS_ALLOW   space-separated host names; `*` matches one DNS label part
  #                (e.g. productionresultssa*.blob.core.windows.net)
  # EGRESS_CLIENTS space-separated CIDRs allowed to use the proxy (the server
  #                passes the job's internal network; default: anyone)
  # CONNECT (HTTPS) is limited to port 443. Plain HTTP may use any port, but
  # only on allowed hosts: self-hosted model endpoints often listen on e.g. 8000.
  local conf=/tmp/tinyproxy.conf filter=/tmp/tinyproxy.filter h re
  : "${EGRESS_ALLOW:?EGRESS_ALLOW is required}"
  : > "${filter}"
  set -f   # host patterns contain `*`: never glob them against the filesystem
  for h in ${EGRESS_ALLOW}; do
    [[ "${h}" =~ ^[A-Za-z0-9*.-]+$ ]] || { echo "egress: bad host pattern: ${h}" >&2; exit 2; }
    re="${h//./\\.}"
    re="${re//\*/[a-z0-9-]*}"
    printf '^%s$\n' "${re}" >> "${filter}"
  done
  set +f
  {
    echo "Port 8888"
    echo "Timeout 1200"
    echo "MaxClients 64"
    echo "LogLevel Connect"
    echo "PidFile \"/tmp/tinyproxy.pid\""
    echo "DisableViaHeader Yes"
    echo "Filter \"${filter}\""
    echo "FilterType ere"
    echo "FilterDefaultDeny Yes"
    echo "ConnectPort 443"
    local c
    for c in ${EGRESS_CLIENTS:-0.0.0.0/0}; do
      [[ "${c}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || { echo "egress: bad client range: ${c}" >&2; exit 2; }
      echo "Allow ${c}"
    done
  } > "${conf}"
  echo "egress: allowing $(wc -l < "${filter}") host pattern(s):" >&2
  sed 's/^/  /' "${filter}" >&2
  exec tinyproxy -d -c "${conf}"
}

case "${1:-}" in
  issue-agent)  exec /opt/agent/run-agent.sh issue ;;
  fix-agent)    exec /opt/agent/run-agent.sh fix ;;
  review-agent) exec /opt/agent/run-agent.sh review ;;
  publish)      exec /opt/agent/publish.sh ;;
  sanitize)     shift; exec python3 /opt/agent/sanitize.py "$@" ;;
  policy)       shift; exec python3 /opt/agent/policy.py "$@" ;;
  egress)       egress ;;
  version)      cat /opt/agent/VERSION ;;
  *) echo "usage: issue-agent | fix-agent | review-agent | publish | sanitize [--json] | policy | egress | version" >&2; exit 2 ;;
esac
