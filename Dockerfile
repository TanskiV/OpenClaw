FROM node:20-slim

# Устанавливаем openclaw глобально
RUN npm install -g openclaw

# Рабочая папка
WORKDIR /app

# Открываем порт (Render всё равно использует $PORT)
EXPOSE 10000

# Стартовый скрипт
CMD ["sh", "-lc", "$(npm bin -g)/openclaw gateway --host 0.0.0.0 --port ${PORT:-10000}"]