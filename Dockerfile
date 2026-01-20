FROM node:20-bookworm

RUN apt-get update && apt-get install -y ffmpeg && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
EXPOSE 5000
CMD ["node", "server.js"]
