FROM node:22-slim

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files and install all deps (need typescript for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Remove dev dependencies after build
RUN npm prune --production

# Expose HTTP port and internal WebSocket port
EXPOSE 3457 3458

ENV PORT=3457
ENV WS_PORT=3458
ENV SESSION_TIMEOUT_MS=1800000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
