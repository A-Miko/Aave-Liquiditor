FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY dist ./dist
COPY node_modules ./node_modules
COPY package.json ./package.json

COPY start.sh ./start.sh
RUN chmod +x ./start.sh

CMD ["./start.sh"]
