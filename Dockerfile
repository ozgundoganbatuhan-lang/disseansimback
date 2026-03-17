FROM node:20-alpine
WORKDIR /app

# native modüller için derleme araçları (better-sqlite3)
RUN apk add --no-cache python3 make g++

# bağımlılıkları önce kopyala (cache katmanı)
COPY package.json ./

# package-lock.json varsa kullan, yoksa npm install'a düş
RUN npm install --omit=dev --prefer-offline || npm install --omit=dev

# uygulama kodunu kopyala
COPY . .

# veri dizinini oluştur (Volume mount edilmezse local fallback)
RUN mkdir -p /data

EXPOSE 4000
CMD ["node", "server.js"]
