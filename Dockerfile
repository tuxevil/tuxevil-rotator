FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node package*.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node README.md CHANGELOG.md LICENSE ./

RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV TUXEVIL_ROTATOR_DIR=/data
ENV TUXEVIL_ROTATOR_CONTAINER=1
EXPOSE 51200
VOLUME ["/data"]

CMD ["node", "--import", "tsx/esm", "src/cli.ts", "start"]
