FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# The linked-session files must survive restarts → mount a volume at /app/auth.
ENV AUTH_DIR=/app/auth
VOLUME ["/app/auth"]

CMD ["node", "index.js"]
