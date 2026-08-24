FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json

RUN pnpm install --frozen-lockfile

COPY apps/api apps/api

# Prisma generation reads the URL but does not connect to the database.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    pnpm --filter @call-now/api db:generate && \
    pnpm --filter @call-now/api build

ENV NODE_ENV=production

EXPOSE 8080

CMD ["pnpm", "--filter", "@call-now/api", "start"]
