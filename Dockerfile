FROM node:20-slim

# Baileys pulls a git-hosted dependency and compiles a little native code,
# so the slim image needs git + build tools before npm install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV AUTH_DIR=/app/auth

CMD ["node", "index.js"]
