// channels/telegram/index.js
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is missing");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

let offset = 0;

async function poll() {
  try {
    const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
    const data = await res.json();

    if (!data.ok) {
      console.error("Telegram API error:", data);
      return;
    }

    for (const upd of data.result) {
      offset = upd.update_id + 1;

      const msg = upd.message;
      if (!msg) continue;

      const chatId = msg.chat?.id;
      const from = msg.from?.username || `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim();
      const text = msg.text || "";

      const { routeIncomingMessage } = require("../../app/router");

const task = routeIncomingMessage({
  source: "telegram",
  chatId,
  author: from,
  text
});

console.log(`[TASK] ${JSON.stringify(task)}`);

// ack back to Telegram
await fetch(`${API}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: `✅ Принято в очередь\nid: ${task.id}`
  })
});

    }
  } catch (e) {
    console.error("Telegram poll error:", e?.message || e);
  }
}

(async function loop() {
  while (true) {
    await poll();
  }
})();

console.log("Telegram long-polling started");

