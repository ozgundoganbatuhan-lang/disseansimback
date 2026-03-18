# Build: 2026-03-18T03:32:51Z
FROM node:20-alpine
WORKDIR /app

# Only need basic tools — no native module compilation needed
RUN apk add --no-cache dumb-init

# Dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Application code
COPY . .

# Railway injects PORT dynamically
EXPOSE 3001

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
