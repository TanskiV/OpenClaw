FROM node:22-slim

RUN npm install -g openclaw@latest

WORKDIR /app

# Render прокидывает PORT; используем его или дефолт 18789
EXPOSE 10000

# Надёжный и минимальный запуск
CMD ["sh", "-c", "openclaw gateway --bind lan --port ${PORT:-18789} --verbose"]