FROM node:24-alpine

WORKDIR /app

# logs/, docs/reports/ 등 실행 중 쓰기 경로가 /app 아래에 있으므로 비루트 사용자가 소유한다.
RUN chown node:node /app

USER node

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 57332

CMD ["node", "server.js"]
