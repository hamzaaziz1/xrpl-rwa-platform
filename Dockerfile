FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Which process to run is decided by the start command in Railway,
# not baked in here. The same image runs the api, the ingest and the
# worker — they share code and differ only in entrypoint.
CMD ["npm", "run", "api"]
