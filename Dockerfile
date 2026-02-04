FROM node:20-slim

RUN npm install -g openclaw

WORKDIR /app

# если твоему сервису надо слушать порт:
# EXPOSE 3000

CMD openclaw