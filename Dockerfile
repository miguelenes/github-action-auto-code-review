FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 STATE_DB=/data/reviews.sqlite
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY runtime ./runtime
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node","dist/cli.js","serve"]
