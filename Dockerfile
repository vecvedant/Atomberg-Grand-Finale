# Cloud Run-ready image.
# The app runs via tsx (no build step) and uses Node's built-in node:sqlite, so it
# needs Node 24+. Cloud Run injects PORT; config.ts reads PORT and binds 0.0.0.0.
FROM node:24-slim
WORKDIR /app

# Puppeteer is only used by the local test scripts in scripts/ — skip the heavy
# Chromium download when building the deploy image.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

# Seed the demo accounts (idempotent) then start the SFU + API server.
CMD ["sh", "-c", "node --import tsx src/seed.ts && node --import tsx src/server.ts"]
