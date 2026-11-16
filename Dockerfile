# TankoBlocs Réseau — image Docker
#
#   docker compose up -d        (voir docker-compose.yml et README.md)

FROM node:26-slim

ENV NODE_ENV=production \
    IN_DOCKER=1 \
    DATA_DIR=/data \
    PORT=8080 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

# dépendances d'abord (mises en cache tant que package*.json ne change pas)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY public ./public
COPY vendor ./vendor
COPY LICENSE NOTICE README.md ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
