FROM oven/bun:1.1-slim

WORKDIR /app

# Copy package files and install production dependencies
COPY package.json tsconfig.json ./
COPY scripts/ ./scripts/
RUN bun install --production

# Patch ssh2 to disable curve25519 key exchange on Bun Linux arm64
RUN sed -i 's/const curve25519Supported =/const curve25519Supported = false; const _unused =/g' node_modules/ssh2/lib/protocol/constants.js

# Copy source code files and game
COPY src/ ./src/
COPY game/ ./game/

# Expose game ports
EXPOSE 10022 10023 13000

# Set default env variables (can be overridden by docker-compose)
ENV CONFIG_PATH=/app/data/config.json
ENV HOST_KEY_PATH=/app/data/host_key
ENV ADMIN_HOST_KEY_PATH=/app/data/admin_host_key

# Run the game by default
CMD ["bun", "run", "game/index.ts"]
