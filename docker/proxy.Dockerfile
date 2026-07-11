# Build context: repo root (docker compose sets this; manual builds:
#   docker build -f docker/proxy.Dockerfile .)
# Multi-stage like the facilitator image; the proxy has no native modules,
# so the runtime stage is just node + the deployed package.

FROM node:26-slim AS build
# corepack is no longer bundled with Node 25+ — install the pinned pnpm directly
RUN npm install -g pnpm@10.34.5
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chainvue/v402-proxy... run build
RUN pnpm --filter @chainvue/v402-proxy --prod deploy /out

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# rules file is mounted here by convention (V402_PROXY_RULES_PATH)
VOLUME /rules
ENV V402_PROXY_HOST=0.0.0.0
ENV V402_PROXY_PORT=8402
ENV V402_PROXY_RULES_PATH=/rules/rules.json
EXPOSE 8402
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8402/.well-known/v402/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
