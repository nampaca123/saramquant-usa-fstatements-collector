FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main.js"]
