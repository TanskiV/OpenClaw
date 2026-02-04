// /opt/openclaw/gateway/app/consumer.js
console.log("Task Consumer started");
const fs = require("fs");
const path = require("path");
const { appendEvent } = require("./appendEvent");

const queueDir = path.join(__dirname, "..", "queue");
const tasksFile = path.join(queueDir, "tasks.jsonl");
const statusFile = path.join(queueDir, "status.json");

function readTasks() {
  if (!fs.existsSync(tasksFile)) return [];
  const raw = fs.readFileSync(tasksFile, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function writeStatus(s) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify(s, null, 2), "utf8");
}

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), text }),
  });
}

function consumeOneFIFO() {
  const tasks = readTasks();
  if (tasks.length === 0) {
    console.log("[CONSUMER] no tasks");
    writeStatus({ state: "idle", ts: new Date().toISOString() });
    return;
  }

  const task = tasks[0]; // FIFO

  const status = {
    state: "picked",
    ts: new Date().toISOString(),
    task: {
      id: task.id,
      author: task.author,
      text: task.text,
      chatId: task.chatId,
    },
  };

  writeStatus(status);
  console.log(`[CONSUME] picked task ${task.id}: ${task.text}`);

  appendEvent({
    taskId: task.id,
    event: "picked",
    by: "consumer",
    meta: { chatId: task.chatId }
  });

  // fire-and-forget notification
  notifyTelegram(`🟡 Взял задачу #${task.id}`).catch(() => {});
}

consumeOneFIFO();
