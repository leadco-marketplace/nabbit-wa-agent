FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV AUTH_DIR=/app/auth

CMD ["node", "index.js"]
