# Builds and runs Aurora (Fastify server + built React PWA served statically by the server) against PostgreSQL.
# Uploads live on a mounted volume; no object storage is used.
# --- Build stage: install all workspaces and build the web bundle -------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build -w @aurora/web

# --- Runtime stage: production deps only (tsx stays a runtime dependency) -----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
RUN npm prune --omit=dev
ENV AURORA_HOST=0.0.0.0 \
    AURORA_PORT=8787 \
    AURORA_UPLOAD_DIR=/data/uploads \
    AURORA_WEB_DIST=/app/apps/web/dist
VOLUME ["/data/uploads"]
EXPOSE 8787
# The server applies pending migrations before bootstrap and starts only after they succeed.
CMD ["npm", "run", "-w", "@aurora/server", "start"]
