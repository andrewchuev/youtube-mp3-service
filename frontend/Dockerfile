FROM node:22-alpine

WORKDIR /app

COPY package.json tsconfig.json next-env.d.ts next.config.ts ./
COPY app ./app
COPY public ./public

RUN npm install
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]
