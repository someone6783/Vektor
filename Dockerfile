FROM node:22-bookworm-slim AS build

ENV CI=true
RUN npm install -g pnpm@10.34.9
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
  && pnpm --config.inject-workspace-packages=true --filter @vektor/api deploy --prod /prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    VEKTOR_DATA_DIR=/data \
    VEKTOR_RUNTIME_ENV=container \
    VEKTOR_WEB_DIST=/app/web-dist

WORKDIR /app

RUN groupadd --system --gid 1001 vektor \
  && useradd --system --uid 1001 --gid vektor --home-dir /app vektor

COPY --from=build --chown=vektor:vektor /prod /app
COPY --from=build --chown=vektor:vektor /app/apps/web/dist /app/web-dist

RUN mkdir -p /data && chown vektor:vektor /data

USER vektor
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
