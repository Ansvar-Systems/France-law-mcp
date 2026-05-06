# Auto-generated Dockerfile for Law MCP HTTP transport.
# Built by rollout-http-transport.sh from Ansvar-Architecture-Documentation.

# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Production ────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist
COPY data/database.db ./data/database.db

# Security: non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs \
 && chown -R nodejs:nodejs /app/data
USER nodejs

ENV NODE_ENV=production

# Clean stale node-sqlite3-wasm lock dirs left over from a SIGKILL'd prior
# run. The library locks via mkdir(<dbpath>.lock); on crash the dir is not
# removed, and the next start fails with "database is locked" forever.
# The bind mount targets the database.db file, so the parent /app/data dir
# is in the container's writable layer and safe to clean.
CMD ["sh", "-c", "rm -rf /app/data/*.lock 2>/dev/null; exec node dist/http-server.js"]
