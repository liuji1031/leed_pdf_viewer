# Node and pnpm versions are pinned to package.json's "engines" / "packageManager".
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.32.1

# ---------------------------------------------------------------------------
# base — node + pnpm via corepack, shared by every other stage
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# corepack ships with node; pin pnpm so local and CI resolve identically
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# Pin the store explicitly. Without this pnpm picks a store on the same volume
# as the project, which differs between the build (image layer) and dev (bind
# mount) and makes `pnpm add` fail with ERR_PNPM_UNEXPECTED_STORE.
RUN pnpm config set store-dir /pnpm/store --global
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install once, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# dev — Vite dev server with HMR. Source is bind-mounted by compose.
# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5173
# .svelte-kit is an anonymous volume (kept out of the bind-mounted source), so
# it starts empty and must be generated before Vite reads tsconfig's "extends".
CMD ["sh", "-c", "pnpm exec svelte-kit sync && pnpm dev --host 0.0.0.0 --port 5173"]

# ---------------------------------------------------------------------------
# test — unit tests (vitest/jsdom). No browsers needed here.
# ---------------------------------------------------------------------------
FROM base AS test
ENV NODE_ENV=test
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["pnpm", "test:run"]

# ---------------------------------------------------------------------------
# build — production build via adapter-node
#
# PUBLIC_* are read through $env/static/public, which SvelteKit INLINES AT
# BUILD TIME. They must arrive as build args; passing them as runtime env
# yields a container that starts fine with silently empty config.
# ---------------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=production \
    ADAPTER=node
ARG PUBLIC_POSTHOG_KEY=""
ARG PUBLIC_APPWRITE_ENDPOINT=""
ARG PUBLIC_APPWRITE_PROJECT_ID=""
ARG PUBLIC_APPWRITE_DATABASE_ID=""
ARG PUBLIC_APPWRITE_STORAGE_BUCKET_ID=""
ARG PUBLIC_APPWRITE_SHARED_PDFS_COLLECTION_ID=""
ARG PUBLIC_APPWRITE_PDF_ANNOTATIONS_COLLECTION_ID=""
ARG PUBLIC_MINERU_ENDPOINT="/mineru"
ENV PUBLIC_POSTHOG_KEY=$PUBLIC_POSTHOG_KEY \
    PUBLIC_APPWRITE_ENDPOINT=$PUBLIC_APPWRITE_ENDPOINT \
    PUBLIC_APPWRITE_PROJECT_ID=$PUBLIC_APPWRITE_PROJECT_ID \
    PUBLIC_APPWRITE_DATABASE_ID=$PUBLIC_APPWRITE_DATABASE_ID \
    PUBLIC_APPWRITE_STORAGE_BUCKET_ID=$PUBLIC_APPWRITE_STORAGE_BUCKET_ID \
    PUBLIC_APPWRITE_SHARED_PDFS_COLLECTION_ID=$PUBLIC_APPWRITE_SHARED_PDFS_COLLECTION_ID \
    PUBLIC_APPWRITE_PDF_ANNOTATIONS_COLLECTION_ID=$PUBLIC_APPWRITE_PDF_ANNOTATIONS_COLLECTION_ID \
    PUBLIC_MINERU_ENDPOINT=$PUBLIC_MINERU_ENDPOINT
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# runtime — adapter-node output only; no pnpm store, no source
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "build"]
