# CMS / admin service. Data persists in a Docker volume mounted at /data.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
