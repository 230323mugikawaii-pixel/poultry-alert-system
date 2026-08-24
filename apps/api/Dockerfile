FROM node:24-bookworm-slim AS base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

FROM base AS workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/migrations/package.json apps/migrations/package.json

FROM workspace AS dependencies

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY apps/api apps/api
COPY apps/migrations apps/migrations

# Prisma generation reads the URL but does not connect to the database.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    pnpm db:generate \
    && pnpm --filter @call-now/api build

FROM build AS production-dependencies

ENV NODE_ENV=production

# Deploy creates a portable package containing declared production dependencies
# only. In particular, Prisma CLI remains outside the API runtime package.
RUN pnpm --filter @call-now/api deploy --prod --legacy /prod/api

FROM build AS migration-dependencies

ENV NODE_ENV=production

RUN pnpm --filter @call-now/migrations deploy --prod --legacy /prod/migrations

FROM base AS migration

ENV NODE_ENV=production

COPY --from=migration-dependencies /prod/migrations apps/migrations
COPY apps/api/prisma apps/api/prisma

USER node

CMD ["apps/migrations/node_modules/.bin/prisma", "migrate", "deploy", "--config", "apps/migrations/prisma.config.ts"]

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=production-dependencies /prod/api/node_modules /app/apps/api/node_modules
COPY --from=production-dependencies /prod/api/package.json /app/apps/api/package.json
COPY --from=build /app/apps/api/dist /app/apps/api/dist

EXPOSE 8080

USER node

CMD ["node", "apps/api/dist/server.js"]
