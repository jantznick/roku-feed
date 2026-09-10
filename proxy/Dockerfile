# Build from repo root (proxy imports ../src):
#   docker build -f proxy/Dockerfile -t roku-hls-proxy .
#   docker compose -f proxy/docker-compose.yml up -d --build

FROM node:20-bookworm-slim

# Chromium runtime deps for Puppeteer-bundled Chrome
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        wget \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install proxy dependencies (Puppeteer downloads Chrome during npm ci)
COPY proxy/package.json proxy/package-lock.json ./proxy/
WORKDIR /app/proxy
RUN npm ci --omit=dev

# App source: proxy + shared src modules it imports
WORKDIR /app
COPY proxy/ ./proxy/
COPY src/ ./src/

ENV NODE_ENV=production
ENV PROXY_HEADLESS=true
ENV PORT=8787
# Override at runtime to your LAN IP:port clients use
ENV PROXY_HOST=192.168.1.50:8787

WORKDIR /app/proxy
EXPOSE 8787

# Do not use --env-file here; compose/env injects vars
CMD ["node", "advanced-proxy.js"]
