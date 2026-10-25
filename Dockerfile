FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

# Versión desplegada (commit), la informa GET /api/health para verificar cada instancia.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 3001

CMD ["node", "index.js"]