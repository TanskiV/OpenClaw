FROM node:22-slim

# Устанавливаем системные пакеты, необходимые для npm пакетов (git, ca-certificates)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем актуальную версию openclaw глобально
RUN npm install -g openclaw@latest

WORKDIR /app

# Render прокидывает PORT; используем 18789 по умолчанию
EXPOSE 18789

# Запуск через shell, чтобы корректно подхватывался ${PORT}
CMD ["sh", "-lc", "openclaw gateway --bind lan --port ${PORT:-18789} --verbose"]