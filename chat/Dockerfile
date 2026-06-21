# Claude proxy for the chatbot. The API key is injected at runtime via env_file (.env),
# never baked into the image and never committed to git.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
