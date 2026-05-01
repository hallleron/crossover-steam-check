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

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /app/.cache

# Runs as root on purpose. Apple's `container` provisions named volumes
# as root-owned, and per-container VM isolation already separates the
# container's root from the host. Switching to a non-root user here
# would just break the cache mount with EACCES on common setups.

EXPOSE 3000
VOLUME ["/app/.cache"]

CMD ["node", "server.js"]
