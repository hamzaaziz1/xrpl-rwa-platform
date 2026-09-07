# ---- build the frontend ----
FROM node:22-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# Vite bakes env vars in at BUILD time, not runtime. Empty string means
# the client calls the same origin it was served from — which is exactly
# right when the API serves the frontend.
ENV VITE_API_URL=""
RUN npm run build

# ---- backend ----
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
COPY --from=web /web/dist ./public

CMD ["npm", "run", "api"]