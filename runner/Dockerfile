# syntax=docker/dockerfile:1.7
#
# maintainer-agent runner image.
#
# One image, several short-lived roles started by the dispatcher (see
# entrypoint.sh): the fix agent, the two triage steps (token-holding fetch
# without a model; model without a token), the output sanitiser, the policy
# validator, and the allow-list egress proxy (tinyproxy) that is the agents'
# only way out of their internal Docker network. mini-swe-agent's `local`
# environment runs the model's bash commands inside the agent container, so
# the container is the sandbox; see README.md, "Security model".
#
# The toolchain is deliberately generic (Python, Node, git, gh, shellcheck,
# hadolint). Repositories that need more build a derivative image
# (FROM louisremi/maintainer-agent) and set it as that repo's `runner_image`
# in the host config.
FROM python:3.13-slim-trixie

# renovate: datasource=pypi depName=mini-swe-agent
ARG MINI_SWE_AGENT_VERSION=2.4.6
# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.101.0
# renovate: datasource=github-releases depName=hadolint/hadolint
ARG HADOLINT_VERSION=2.15.1
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      ca-certificates curl git jq less nodejs npm procps shellcheck tinyproxy-bin; \
    rm -rf /var/lib/apt/lists/*; \
    arch="${TARGETARCH:-amd64}"; \
    curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
      | grep " gh_${GH_VERSION}_linux_${arch}.tar.gz$" | sed "s#  .*#  /tmp/gh.tgz#" | sha256sum --check --strict -; \
    tar -xzf /tmp/gh.tgz -C /tmp; install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh*; \
    hl_arch="$([ "$arch" = arm64 ] && echo arm64 || echo x86_64)"; \
    curl -fsSL -o /usr/local/bin/hadolint "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-${hl_arch}"; \
    curl -fsSL "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/checksums.sha256" \
      | awk -v f="*hadolint-linux-${hl_arch}" '$2 == f {print $1"  /usr/local/bin/hadolint"}' | sha256sum --check --strict -; \
    chmod 0755 /usr/local/bin/hadolint; \
    pip install --no-cache-dir --disable-pip-version-check "mini-swe-agent==${MINI_SWE_AGENT_VERSION}"; \
    mini --help >/dev/null; gh --version; hadolint --version

RUN useradd --create-home --uid 10001 agent \
    && mkdir -p /work /runs /opt/agent \
    && chown agent:agent /work /runs

ARG AGENT_VERSION=dev
COPY --chmod=0644 config/ /opt/agent/config/
COPY --chmod=0644 playbooks/ /opt/agent/playbooks/
COPY --chmod=0755 entrypoint.sh run-fix.sh run-triage.sh sanitize.py policy.py /opt/agent/
COPY --chmod=0755 agent-pr ci-wait /usr/local/bin/
RUN echo "${AGENT_VERSION}" > /opt/agent/VERSION

USER agent
WORKDIR /work
ENV MSWEA_CONFIGURED=1 \
    MSWEA_SILENT_STARTUP=1 \
    MSWEA_COST_TRACKING=ignore_errors \
    MSWEA_GLOBAL_CONFIG_DIR=/tmp/mswea \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    GIT_TERMINAL_PROMPT=0 \
    GH_PROMPT_DISABLED=1 \
    PAGER=cat

LABEL org.opencontainers.image.title="maintainer-agent" \
      org.opencontainers.image.description="Sandboxed mini-swe-agent runner that triages issues and proposes changes in GitHub repositories" \
      org.opencontainers.image.source="https://github.com/louisremi/maintainer-agent" \
      org.opencontainers.image.version="${AGENT_VERSION}"

ENTRYPOINT ["/opt/agent/entrypoint.sh"]
