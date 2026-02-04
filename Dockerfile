FROM node:20-slim

RUN npm install -g openclaw

WORKDIR /app

# Обязательно: Render прокидывает PORT, используем 10000 по умолчанию
EXPOSE 10000

# Используем глобальный бинарник — надёжнее, чем хардкодить путь внутри node_modules
CMD ["sh", "-lc", "$(npm bin -g)/openclaw gateway --host 0.0.0.0 --port ${PORT:-10000}"]