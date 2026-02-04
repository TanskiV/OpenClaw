FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY app ./app
COPY app/index.js ./index.js

COPY channels ./channels

CMD ["node", "index.js"]
