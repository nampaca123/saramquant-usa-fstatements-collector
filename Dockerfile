FROM node:24-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

# slim(glibc) 기반 — @duckdb/node-api 프리빌트 바이너리는 musl(alpine) 미보장
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions
# 확장을 빌드 시점에 굽고 곧바로 오프라인 로드를 검증한다 — 실패하면 빌드가 죽는다
RUN node -e "const{DuckDBInstance}=require('@duckdb/node-api');(async()=>{const i=await DuckDBInstance.create(':memory:');const c=await i.connect();await c.run(\"SET extension_directory='/opt/duckdb/extensions'\");for(const e of['httpfs','avro','iceberg'])await c.run('INSTALL '+e);})().catch(e=>{console.error(e);process.exit(1)})" \
 && node -e "const{DuckDBInstance}=require('@duckdb/node-api');(async()=>{const i=await DuckDBInstance.create(':memory:');const c=await i.connect();await c.run(\"SET extension_directory='/opt/duckdb/extensions'\");await c.run('SET autoinstall_known_extensions=false');await c.run('SET autoload_known_extensions=false');for(const e of['httpfs','avro','iceberg'])await c.run('LOAD '+e);console.log('offline load ok')})().catch(e=>{console.error(e);process.exit(1)})"
CMD ["node", "dist/main.js"]
