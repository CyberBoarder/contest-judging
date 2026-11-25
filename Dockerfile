# 공모전 온라인 심사평가 시스템 (외부 패키지 없음)
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    TZ=Asia/Seoul

WORKDIR /app
RUN apk add --no-cache tzdata
COPY package.json server.js ./
COPY public ./public
# 출품작 seed는 이미지에 넣지 않고 docker-compose에서 읽기 전용으로 연결
RUN mkdir -p /app/data /app/seed && chown -R node:node /app/data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/meta > /dev/null || exit 1

CMD ["node", "server.js"]
