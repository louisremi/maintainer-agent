# syntax=docker/dockerfile:1.7
#
# maintainer-agent server: receives forge webhooks, queues maintenance jobs
# and runs the agents as sibling containers of the runner image through the
# Docker API (see compose.example.yaml at the repository root).
FROM node:24-trixie-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-trixie-slim
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ARG AGENT_VERSION=dev
ENV NODE_ENV=production \
    DATA_DIR=/srv/maintainer-agent \
    PORT=3000 \
    MAINTAINER_AGENT_VERSION=${AGENT_VERSION}
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
LABEL org.opencontainers.image.title="maintainer-agent-server" \
      org.opencontainers.image.description="Self-hosted maintainer agent server: GitHub App webhooks, job queue, sandboxed agents" \
      org.opencontainers.image.source="https://github.com/louisremi/maintainer-agent" \
      org.opencontainers.image.version="${AGENT_VERSION}"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/bootstrap/main.js"]
