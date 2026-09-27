FROM node:22.22.2-trixie-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install

COPY . .

RUN chmod +x docker-entrypoint.sh && npx prisma generate

ENV NODE_ENV=production

EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
