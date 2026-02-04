// /opt/openclaw/gateway/app/consumer.js
console.log("Task Consumer started");
const fs = require("fs");
const path = require("path");
const { appendEvent } = require("./appendEvent");

const queueDir = path.join(__dirname, "..", "queue");
const tasksFile = path.join(queueDir, "tasks.jsonl");
const statusFile = path.join(queueDir, "status.json");
const processedFile = path.join(queueDir, "processed.jsonl");
const eventsFile = path.join(queueDir, "task_events.jsonl");

function touchFile(file) {
  fs.mkdirSync(queueDir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.closeSync(fs.openSync(file, "a"));
  }
}

function ensureQueueFiles() {
  fs.mkdirSync(queueDir, { recursive: true });
  touchFile(eventsFile);
  touchFile(processedFile);
  touchFile(tasksFile);
  touchFile(statusFile);
}

function readTaskLines() {
  if (!fs.existsSync(tasksFile)) return [];
  const raw = fs.readFileSync(tasksFile, "utf8");
  if (!raw.trim()) return [];
  return raw.split("\n").filter((l) => l.trim().length > 0);
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
  ensureQueueFiles();

  const lines = readTaskLines();
  if (lines.length === 0) {
    writeStatus({ state: "idle", ts: new Date().toISOString() });
    return;
  }

  const task = JSON.parse(lines[0]); // FIFO

  try {
    appendEvent({
      taskId: task.id,
      event: "picked",
      by: "consumer",
      meta: { chatId: task.chatId }
    });

    notifyTelegram(`🟡 Взял задачу #${task.id}`).catch(() => {});

    writeStatus({
      state: "picked",
      ts: new Date().toISOString(),
      task: {
        id: task.id,
        author: task.author,
        text: task.text,
        chatId: task.chatId,
      },
    });
    console.log(`picked task ${task.id}: ${task.text}`);

    appendEvent({
      taskId: task.id,
      event: "done",
      by: "consumer",
      meta: { chatId: task.chatId }
    });

    fs.appendFileSync(processedFile, JSON.stringify(task) + "\n", "utf8");

    const remaining = lines.slice(1);
    fs.writeFileSync(tasksFile, remaining.length > 0 ? remaining.join("\n") + "\n" : "", "utf8");

    writeStatus({
      state: "done",
      ts: new Date().toISOString(),
      task: {
        id: task.id,
        author: task.author,
        text: task.text,
        chatId: task.chatId,
      },
    });
    console.log(`done task ${task.id}`);
  } catch (err) {
    const reason = err?.message || String(err);

    appendEvent({
      taskId: task.id,
      event: "error",
      by: "consumer",
      meta: { chatId: task.chatId, reason }
    });

    fs.appendFileSync(processedFile, JSON.stringify(task) + "\n", "utf8");

    const remaining = lines.slice(1);
    fs.writeFileSync(tasksFile, remaining.length > 0 ? remaining.join("\n") + "\n" : "", "utf8");

    writeStatus({
      state: "error",
      ts: new Date().toISOString(),
      task: {
        id: task.id,
        author: task.author,
        text: task.text,
        chatId: task.chatId,
      },
      error: reason,
    });
    console.log(`error task ${task.id}: ${reason}`);
  }
}

consumeOneFIFO();
