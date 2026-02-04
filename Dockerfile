FROM node:20-slim

RUN npm install -g openclaw

WORKDIR /app

# На всякий случай, чтобы Render точно видел глобальные бинарники
ENV PATH="/usr/local/bin:${PATH}"

# Самый надежный запуск: напрямую через node по реальному пути
CMD ["node", "/usr/local/lib/node_modules/openclaw/openclaw.mjs"]