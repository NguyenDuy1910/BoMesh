# syntax=docker/dockerfile:1
#
# BoMesh WebUI image (build context: apps/web/): Next.js standalone server on 0.0.0.0:3000.
# NEXT_PUBLIC_* values are inlined at build time. An empty NEXT_PUBLIC_BOMESH_API_URL
# makes the client call the API with same-origin relative URLs (/api, /upload, /health).

ARG NODE_IMAGE=node:24.22.3-bookworm-slim

FROM oven/bun:1.4.0-slim AS bun

FROM ${NODE_IMAGE} AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM ${NODE_IMAGE} AS builder
ARG NEXT_PUBLIC_BOMESH_API_URL=""
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=""
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BOMESH_API_URL=${NEXT_PUBLIC_BOMESH_API_URL} \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node node_modules/next/dist/bin/next build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
