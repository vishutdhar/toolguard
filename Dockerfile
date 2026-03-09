FROM node:20-alpine AS build

WORKDIR /app
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

COPY package*.json ./
COPY prisma ./prisma
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=1 npm ci
RUN npx prisma generate

COPY src ./src
COPY examples ./examples
COPY docs ./docs
COPY tsconfig.json ./tsconfig.json
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

COPY package*.json ./
COPY prisma ./prisma
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=1 npm ci
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY --from=build /app/docs ./docs
COPY --from=build /app/examples ./examples

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]
