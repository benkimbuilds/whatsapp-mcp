# whatsapp-mcp — one container per WhatsApp session.
# Override at runtime: PORT, AUTH_DIR, MCP_BEARER_TOKEN, SESSION_ROLE, ALLOW_SEND, ALLOW_DELETE, HOST, ALLOWED_HOSTS.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV AUTH_DIR=/data/auth
ENV PORT=8787
ENV HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 8787 8788

CMD ["node", "dist/index.js"]
