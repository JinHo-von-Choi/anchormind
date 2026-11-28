FROM rust:1.97-alpine AS native-build

RUN apk add --no-cache build-base git
WORKDIR /build
COPY native/ ./
RUN cargo build --locked --release

FROM node:24-alpine AS runtime

WORKDIR /app

# logs/, docs/reports/ 등 실행 중 쓰기 경로가 /app 아래에 있으므로 비루트 사용자가 소유한다.
RUN chown node:node /app

USER node

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 57332

CMD ["node", "server.js"]

FROM runtime AS native
COPY --from=native-build --chown=node:node /build/target/release/libanchormind_tokenizers.so /app/native/tokenizers.node

FROM runtime AS standard
