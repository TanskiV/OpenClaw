FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=512"

CMD ["sh", "-lc", "openclaw --help"]