FROM node:20-slim

RUN npm install -g openclaw

WORKDIR /app

# Обязательно: Render прокидывает PORT, используем 10000 по умолчанию
EXPOSE 10000

# На всякий случай гарантируем, что глобальные бинарари в PATH
ENV PATH="/usr/local/bin:${PATH}"

# Копируем скрипт-обёртку и делаем его исполняемым
COPY ./run-openclaw.sh /usr/local/bin/run-openclaw.sh
RUN chmod +x /usr/local/bin/run-openclaw.sh

# Надёжный запуск через скрипт-обёртку
CMD ["/usr/local/bin/run-openclaw.sh"]