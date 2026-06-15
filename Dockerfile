# syntax=docker/dockerfile:1

# ---- build: compile the whole monorepo once ----
FROM node:22-bookworm AS build
WORKDIR /app
# Toolchain for better-sqlite3 in case a prebuilt binary isn't available for the arch.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Install against the full workspace manifest set so the lockfile + file: links resolve.
COPY package.json package-lock.json ./
COPY packages/sonos-protocol/package.json packages/sonos-protocol/
COPY apps/bridge/package.json apps/bridge/
COPY apps/web/package.json apps/web/
COPY apps/grateful-smapi/package.json apps/grateful-smapi/
COPY apps/phish-smapi/package.json apps/phish-smapi/
COPY apps/ytmusic-smapi/package.json apps/ytmusic-smapi/
COPY apps/lma-smapi/package.json apps/lma-smapi/
COPY apps/podcast-smapi/package.json apps/podcast-smapi/
RUN npm ci
COPY . .
RUN npm run build

# ---- node-runtime: the backend services (bridge + SMAPI sources) ----
FROM node:22-bookworm-slim AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
# node_modules carries the compiled better-sqlite3 binary and the @misonos/* symlinks,
# which point into ./packages — so copy both. apps/* brings each service's dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./package.json
# Overridden per-service by docker-compose; bridge is the sensible default.
CMD ["node", "apps/bridge/dist/index.js"]

# ---- web: static PWA served + /api reverse-proxied to the bridge ----
FROM caddy:2-alpine AS web
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
