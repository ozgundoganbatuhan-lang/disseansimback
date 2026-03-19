# Build: 2026-03-19T00:05:01Z
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache dumb-init
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
