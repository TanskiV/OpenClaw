FROM node:20-alpine

WORKDIR /app

COPY app ./app
COPY app/index.js ./index.js

COPY channels ./channels

CMD ["node", "index.js"]
