# Runs src/serve.ts's network-facing entrypoint (MCP over HTTP, the REST
# dashboard API, and the websocket clipboard-push channel) -- NOT the
# clipboard watcher (src/clipboard-watcher.ts), which must run natively on
# the Windows desktop and is never invoked from this image. See README.md's
# "Remote access / Docker" section.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY web ./web

# Run as the image's built-in unprivileged user rather than root, in case a
# future dependency vuln or request-handling bug is ever exploited. The
# host directories bind-mounted at /config (read-write), /game-logs, and
# /pob-builds (both read-only, per docker-compose.yml) must be readable --
# and /config writable -- by this container's node user (uid 1000); adjust
# host directory permissions if you hit EACCES after upgrading.
USER node

EXPOSE 8787
CMD ["node", "dist/serve.js"]
