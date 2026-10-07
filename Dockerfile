FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY scripts ./scripts
COPY server.js ./
# Fila durável: monte um VOLUME PERSISTENTE em /data (EasyPanel → Mounts).
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
