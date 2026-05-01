# syntax=docker/dockerfile:1.7
# Multi-arch image: works under Docker, Podman, and Apple `container`.
# node:20-alpine ships both arm64 and amd64 variants.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

# Pre-create the cache dir so the volume mount (or in-container writes)
# work without root. The "node" user (uid 1000) ships with the base image.
RUN mkdir -p /app/.cache && chown -R node:node /app/.cache

USER node
EXPOSE 3000
VOLUME ["/app/.cache"]

CMD ["node", "server.js"]
