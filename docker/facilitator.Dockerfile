# Build context: repo root (docker compose sets this; manual builds:
#   docker build -f docker/facilitator.Dockerfile .)
# Multi-stage: workspace build with native-module toolchain, then a minimal
# non-root runtime with only the deployed production package.

FROM node:26-slim AS build
# better-sqlite3 falls back to node-gyp when no prebuild matches — toolchain
# lives ONLY in this stage
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# corepack is no longer bundled with Node 25+ — install the pinned pnpm directly
RUN npm install -g pnpm@10.34.5
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# build the facilitator plus all its workspace dependencies (topological)
RUN pnpm --filter @chainvue/v402-facilitator... run build
# self-contained production package (dist + prod node_modules incl. workspace deps)
RUN pnpm --filter @chainvue/v402-facilitator --prod deploy /out

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# SQLite lives on the volume; owned by the unprivileged node user
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV DB_PATH=/data/v402.sqlite
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
