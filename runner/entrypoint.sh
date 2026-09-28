#!/usr/bin/env bash
# Container entrypoint. One image, several roles, all started by the
# dispatcher (dispatcher/dispatch.sh):
#
#   fix <n>            fix mode (model + write token, egress via the proxy)
#   triage-fetch <n>   triage step 1: read-only token, NO model, snapshots context
#   triage-agent <n>   triage step 2: model, NO token, egress = model endpoint only
#   sanitize           stdin -> stdout, exit 3 = hold (run with --network none)
#   policy             stdin YAML -> stdout JSON, exit 1 = invalid (--network none)
#   egress             allow-list HTTP(S) proxy (tinyproxy) for the agent network
set -euo pipefail

egress() {
  # EGRESS_ALLOW   space-separated host names; `*` matches one DNS label part
  #                (e.g. productionresultssa*.blob.core.windows.net)
  # EGRESS_CLIENTS space-separated CIDRs allowed to use the proxy
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
    for c in ${EGRESS_CLIENTS:-0.0.0.0/0}; do echo "Allow ${c}"; done
  } > "${conf}"
  echo "egress: allowing $(wc -l < "${filter}") host pattern(s):" >&2
  sed 's/^/  /' "${filter}" >&2
  exec tinyproxy -d -c "${conf}"
}

case "${1:-}" in
  fix)          shift; exec /opt/agent/run-fix.sh "$@" ;;
  triage-fetch) shift; exec /opt/agent/run-triage.sh fetch "$@" ;;
  triage-agent) shift; exec /opt/agent/run-triage.sh agent "$@" ;;
  sanitize)     shift; exec python3 /opt/agent/sanitize.py "$@" ;;
  policy)       shift; exec python3 /opt/agent/policy.py "$@" ;;
  egress)       egress ;;
  version)      cat /opt/agent/VERSION ;;
  *) echo "usage: {fix|triage-fetch|triage-agent} <issue-number> | sanitize | policy | egress | version" >&2; exit 2 ;;
esac
