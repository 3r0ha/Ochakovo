# syntax=docker/dockerfile:1.7
# Один образ: сайт (собранный Vite) + API + боты. Сборка: docker build -t ochakovo-season .
# Для MAX и GigaChat заранее скачайте сертификат Минцифры: sh scripts/max-cert.sh — он попадёт в образ.

ARG NODE_VERSION=24

# ── Зависимости ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Только то, что нужно серверу: Hono, драйвер Postgres, sharp, tsx ─────────
# Сайт приходит собранным в dist — React, сборщик, TypeScript и Playwright в рабочий образ не попадают
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── Сборка сайта с проверкой типов ────────────────────────────────────────
# Ролики «Смена изнутри» (public/video/*.mp4) Vite кладёт в dist/video — оттуда их раздаёт сервер с Range и кэшем.
# Серверу из public нужны манифест роликов, фото и знаки для ботов, а вторая копия роликов (около 17 МБ) — нет
FROM deps AS build
COPY . .
RUN pnpm build \
 && test -n "$(find dist/video -name '*.mp4' 2>/dev/null)" \
 && mkdir -p /app/public-runtime && cp -a public/. /app/public-runtime/ \
 && find /app/public-runtime -name '*.mp4' -delete

# ── Рабочий образ ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app

# Сервер запускается из TypeScript через tsx — он среди рабочих зависимостей
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.node.json ./
COPY server ./server
COPY shared ./shared
COPY --from=build /app/public-runtime ./public
COPY certs ./certs
COPY --from=build /app/dist ./dist

# Бот складывает сюда сгенерированные картинки; остальное — только для чтения
RUN mkdir -p server/.generated && chown -R node:node server/.generated

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Сертификат Минцифры подключается, только если он есть в certs/ (нужен для MAX и GigaChat)
CMD ["sh", "-c", "if [ -f /app/certs/russian_trusted_root_ca.pem ]; then export NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem; fi; exec node --import tsx server/index.ts"]
