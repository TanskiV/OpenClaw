// channels/telegram/index.js
const fs = require("fs");
const path = require("path");
const { appendEvent } = require("../../app/appendEvent");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is missing");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

const queueDir = path.join(__dirname, "..", "..", "queue");
const tasksFile = path.join(queueDir, "tasks.jsonl");
const processedFile = path.join(queueDir, "processed.jsonl");
const pauseFlag = path.join(queueDir, "PAUSE");
const executorDisabledFlag = path.join(queueDir, "EXECUTOR_DISABLED");
const APPROVER_CHAT_ID = 351234246;

let offset = 0;

function touchFile(file) {
  fs.mkdirSync(queueDir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.closeSync(fs.openSync(file, "a"));
  }
}

async function sendMessage(chatId, text) {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function readProcessedTask(taskId) {
  if (!fs.existsSync(processedFile)) return null;
  const raw = fs.readFileSync(processedFile, "utf8");
  if (!raw.trim()) return null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const task = JSON.parse(line);
      if (String(task.id) === String(taskId)) {
        return task;
      }
    } catch (err) {
      continue;
    }
  }
  return null;
}

function appendTask(task) {
  fs.appendFileSync(tasksFile, JSON.stringify(task) + "\n", "utf8");
}

async function handleCommand(text, chatId) {
  const trimmed = text.trim();

  const approveMatch = trimmed.match(/^\/approve\s+(\S+)/i) || trimmed.match(/^approve\s+#?(\S+)/i);
  if (approveMatch) {
    if (chatId !== APPROVER_CHAT_ID) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    const taskId = approveMatch[1].replace(/^#/, "");
    appendEvent({ taskId, event: "approved", by: "operator", meta: { chatId } });
    await sendMessage(chatId, `Approved #${taskId}`);
    return true;
  }

  const replayMatch = trimmed.match(/^\/replay\s+(\S+)/i) || trimmed.match(/^replay\s+#?(\S+)/i);
  if (replayMatch) {
    if (chatId !== APPROVER_CHAT_ID) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    const taskId = replayMatch[1].replace(/^#/, "");
    touchFile(processedFile);
    touchFile(tasksFile);
    const task = readProcessedTask(taskId);
    if (!task) {
      await sendMessage(chatId, `Task #${taskId} not found in processed`);
      return true;
    }
    appendTask(task);
    appendEvent({ taskId, event: "replayed", by: "operator", meta: { chatId } });
    await sendMessage(chatId, `Requeued #${taskId}`);
    return true;
  }

  if (trimmed === "/pause") {
    if (chatId !== APPROVER_CHAT_ID) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    touchFile(pauseFlag);
    await sendMessage(chatId, "Queue paused");
    return true;
  }

  if (trimmed === "/resume") {
    if (chatId !== APPROVER_CHAT_ID) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    if (fs.existsSync(pauseFlag)) fs.unlinkSync(pauseFlag);
    await sendMessage(chatId, "Queue resumed");
    return true;
  }

  if (trimmed === "/disable_executor") {
    if (chatId !== APPROVER_CHAT_ID) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    touchFile(executorDisabledFlag);
    await sendMessage(chatId, "Executor disabled");
    return true;
  }

  if (trimmed === "/enable_executor") {
    if (chatId !== APPROVER_CHAT_ID) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    if (fs.existsSync(executorDisabledFlag)) fs.unlinkSync(executorDisabledFlag);
    await sendMessage(chatId, "Executor enabled");
    return true;
  }

  return false;
}

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

      if (text && await handleCommand(text, chatId)) {
        continue;
      }

      const { routeIncomingMessage } = require("../../app/router");

      const task = routeIncomingMessage({
        source: "telegram",
        chatId,
        author: from,
        text
      });

      console.log(`[TASK] ${JSON.stringify(task)}`);

      await sendMessage(chatId, "Принял 👍");
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
