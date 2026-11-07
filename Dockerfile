# syntax=docker/dockerfile:1

# ---------- build: install all workspaces, bundle the server, build the web app
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY apps/web/package.json apps/web/
COPY loadtest/package.json loadtest/
RUN npm ci
COPY . .
RUN npm run build -w @courier/server && npm run build -w @courier/web

# ---------- gateway runtime: bundled server + production deps only
FROM node:22-alpine AS gateway
ENV NODE_ENV=production
WORKDIR /app
COPY packages/server/package.json ./
# The protocol package is bundled into dist, so drop the workspace references.
RUN sed -i '/"@courier\//d' package.json && npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/packages/server/dist ./dist
COPY packages/server/migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Node handles SIGTERM itself (graceful drain), so run it as PID 1 directly.
CMD ["node", "dist/main.js"]

# ---------- edge: nginx serving the web app and load-balancing the gateways
FROM nginx:1.27-alpine AS edge
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
