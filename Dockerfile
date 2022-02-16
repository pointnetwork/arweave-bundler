FROM node:14.17.5-stretch-slim

WORKDIR /app
COPY . /app/

RUN npm i -g npm && npm i && npm run build

# WTF?!?!?
# grep -n "localhost" node_modules/testweave-sdk/dist/classes/class.testweave-transactions-manager.js
# 128:                        request.defaults.baseURL = 'http://localhost';
# 159:                            request.defaults.baseURL = 'http://localhost';

RUN sed -i '128d' node_modules/testweave-sdk/dist/classes/class.testweave-transactions-manager.js

ENTRYPOINT [ "npm", "start" ]
