# =============================================================================
# Noosphere Agent - Docker Build (Docker-in-Docker)
# =============================================================================
# Multi-stage build for optimized image size
# DinD pattern: Agent manages containers via Docker socket
# Containers defined in config.json are auto-started
#
# Usage:
#   docker build -t noosphere-agent .
#   docker compose up -d
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# -----------------------------------------------------------------------------
# Stage 2: Builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js app (for dashboard)
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: Production Runner
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Install runtime dependencies including docker-cli for DinD
RUN apk add --no-cache curl tini docker-cli

# Create non-root user with docker group access
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 agent && \
    addgroup agent docker 2>/dev/null || true

# Copy built application
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/src ./src
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/app ./app
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/schema.sql ./schema.sql
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/tailwind.config.ts ./tailwind.config.ts
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data directory with correct permissions
RUN mkdir -p /app/.noosphere && chown -R agent:nodejs /app/.noosphere

# Environment variables
ENV NODE_ENV=production
ENV NOOSPHERE_DATA_DIR=/app/.noosphere

# Expose ports
# 3000: Next.js Dashboard
# 4000: Express API
EXPOSE 3000 4000

# Use tini as init system for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Note: Running as root for Docker socket access
# The socket permissions vary by host OS
# For production, consider using rootless Docker or proper group permissions

CMD ["/entrypoint.sh"]
