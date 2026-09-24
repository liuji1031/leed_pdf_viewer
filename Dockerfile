# Node and pnpm versions are pinned to package.json's "engines" / "packageManager".
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.32.1

# Every stage runs as uid 1000 — `node` in the Node image, `ubuntu` in the
# Playwright one. Anything a container writes into the bind-mounted checkout
# (build/, test-results/, .svelte-kit/) is then owned by the host user rather
# than root, so it can be deleted without sudo. Matches the default uid of a
# single-user Linux host.

# ---------------------------------------------------------------------------
# base — node + pnpm via corepack, shared by the Node stages
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
# COREPACK_HOME moves corepack's download cache off /root, where uid 1000
# couldn't read the pnpm it prepared.
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/corepack \
    PATH=/pnpm:$PATH \
    CI=true
RUN mkdir -p /pnpm/store /corepack /app \
    && chown -R node:node /pnpm /corepack /app \
    && corepack enable
USER node
RUN corepack prepare pnpm@${PNPM_VERSION} --activate \
    # Pin the store explicitly. Otherwise pnpm picks a store on the same volume
    # as the project, which differs between the image and a bind mount and
    # makes `pnpm add` fail with ERR_PNPM_UNEXPECTED_STORE.
    && pnpm config set store-dir /pnpm/store --global
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install once, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM base AS deps
COPY --chown=node:node package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# workspace — deps + source. dev/test build on this.
#
# compose mounts an anonymous volume over node_modules, which Docker seeds from
# this path — ownership included. COPY --from always writes root:root unless
# told otherwise, so --chown is what keeps node_modules writable for the Vite
# and imagetools caches.
# ---------------------------------------------------------------------------
FROM base AS workspace
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# ---------------------------------------------------------------------------
# dev — Vite dev server with HMR. Source is bind-mounted by compose.
# ---------------------------------------------------------------------------
FROM workspace AS dev
ENV NODE_ENV=development
EXPOSE 5173
# Generate .svelte-kit before Vite reads tsconfig's "extends"; on a fresh
# checkout it doesn't exist yet.
CMD ["sh", "-c", "pnpm exec svelte-kit sync && pnpm dev --host 0.0.0.0 --port 5173"]

# ---------------------------------------------------------------------------
# test — unit tests (vitest/jsdom). No browsers needed here.
# ---------------------------------------------------------------------------
FROM workspace AS test
ENV NODE_ENV=test
CMD ["pnpm", "test:run"]

# ---------------------------------------------------------------------------
# e2e — Playwright with bundled Chromium/Firefox/WebKit and project deps.
# The tag must track @playwright/test in package.json, or the browser builds
# won't match the client. It ships Node 24, which satisfies engine-strict.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS e2e
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/corepack \
    PATH=/pnpm:$PATH \
    CI=true
RUN mkdir -p /pnpm/store /corepack /app \
    && chown -R 1000:1000 /pnpm /corepack /app \
    && corepack enable
USER 1000
RUN corepack prepare pnpm@${PNPM_VERSION} --activate \
    && pnpm config set store-dir /pnpm/store --global
WORKDIR /app
COPY --chown=1000:1000 package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile
COPY --chown=1000:1000 . .
# With CI=true, playwright.config's webServer only runs `pnpm preview`, so build
# first — as .github/workflows/e2e.yml does. Arguments after the service name
# pass through to Playwright:
#   docker compose --profile test run --rm e2e --project=firefox tests/e2e/x.spec.ts
ENTRYPOINT ["sh", "-c", "pnpm build && pnpm exec playwright test \"$@\"", "--"]
CMD []

# ---------------------------------------------------------------------------
# build — production build via adapter-node
#
# PUBLIC_* are read through $env/static/public, which SvelteKit INLINES AT
# BUILD TIME. They must arrive as build args; passing them as runtime env
# yields a container that starts fine with silently empty config.
# ---------------------------------------------------------------------------
FROM workspace AS build
ENV NODE_ENV=production \
    ADAPTER=node
ARG PUBLIC_POSTHOG_KEY=""
ARG PUBLIC_APPWRITE_ENDPOINT=""
ARG PUBLIC_APPWRITE_PROJECT_ID=""
ARG PUBLIC_APPWRITE_DATABASE_ID=""
ARG PUBLIC_APPWRITE_STORAGE_BUCKET_ID=""
ARG PUBLIC_APPWRITE_SHARED_PDFS_COLLECTION_ID=""
ARG PUBLIC_APPWRITE_PDF_ANNOTATIONS_COLLECTION_ID=""
ENV PUBLIC_POSTHOG_KEY=$PUBLIC_POSTHOG_KEY \
    PUBLIC_APPWRITE_ENDPOINT=$PUBLIC_APPWRITE_ENDPOINT \
    PUBLIC_APPWRITE_PROJECT_ID=$PUBLIC_APPWRITE_PROJECT_ID \
    PUBLIC_APPWRITE_DATABASE_ID=$PUBLIC_APPWRITE_DATABASE_ID \
    PUBLIC_APPWRITE_STORAGE_BUCKET_ID=$PUBLIC_APPWRITE_STORAGE_BUCKET_ID \
    PUBLIC_APPWRITE_SHARED_PDFS_COLLECTION_ID=$PUBLIC_APPWRITE_SHARED_PDFS_COLLECTION_ID \
    PUBLIC_APPWRITE_PDF_ANNOTATIONS_COLLECTION_ID=$PUBLIC_APPWRITE_PDF_ANNOTATIONS_COLLECTION_ID
RUN pnpm build

# ---------------------------------------------------------------------------
# prod-deps — runtime dependencies only. adapter-node bundles devDependencies
# into the build and leaves `dependencies` external, so only these ship.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY --chown=node:node package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=1000,gid=1000 \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# runtime — adapter-node output only; no pnpm store, no source, no dev deps
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
    CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build"]
