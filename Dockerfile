FROM node:20-slim

RUN npm install -g openclaw

WORKDIR /app

# Обязательно: Render прокидывает PORT, используем 10000 по умолчанию
EXPOSE 10000

# На всякий случай гарантируем, что глобальные бинари в PATH
ENV PATH="/usr/local/bin:${PATH}"

# Надёжный запуск: используем sh -c и exec, без -l (оно может не поддерживаться в sh на платформе)
CMD ["sh", "-c", "exec openclaw gateway --host 0.0.0.0 --port ${PORT:-10000}"]