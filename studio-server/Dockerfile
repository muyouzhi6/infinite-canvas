FROM node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./

ENV NODE_ENV=production
ENV PORT=3100
ENV DATA_DIR=/data

EXPOSE 3100
CMD ["node", "server.mjs"]
