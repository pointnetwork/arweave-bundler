FROM node:14.17.5-stretch-slim

WORKDIR /app
COPY . /app/

RUN npm i -g npm && npm ci && npm run build

ENTRYPOINT [ "npm", "start" ]
