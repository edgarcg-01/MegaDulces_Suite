# Dockerfile dedicado a feeds-ingest (Fase SYNC).
# El servicio lo selecciona con la env RAILWAY_DOCKERFILE_PATH=services/feeds-ingest/Dockerfile
# → NO afecta a los demás servicios (que siguen usando el Dockerfile raíz del API).
# El contexto de build es la raíz del repo (railway up sube el git root), pero aquí solo
# copiamos esta carpeta, que es self-contained (server.js + apply-handlers.js + package.json).
FROM node:20-bookworm-slim
WORKDIR /app
COPY services/feeds-ingest/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY services/feeds-ingest/ ./
ENV NODE_ENV=production
# El servidor escucha en process.env.PORT (lo inyecta Railway).
CMD ["node", "server.js"]
