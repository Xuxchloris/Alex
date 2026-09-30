FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY apps/alex ./apps/alex
COPY packages/alex-core ./packages/alex-core
COPY services ./services
COPY scripts/alex-doctor.mjs scripts/alex-backup.mjs scripts/alex-live-smoke.mjs ./scripts/
RUN mkdir -p /data/alex && chown node:node /data/alex
ENV NODE_ENV=production ALEX_DATA_DIR=/data/alex ALEX_CHROMIUM_PATH=/usr/bin/chromium ALEX_BIND_HOST=0.0.0.0
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["node", "scripts/alex-doctor.mjs", "--health-only", "--json"]
CMD ["node", "--use-env-proxy", "apps/alex/server.mjs"]
