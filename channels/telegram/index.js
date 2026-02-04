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
const APPROVER_CHAT_IDS = new Set([351234246, 306786415]);
const eventsFile = path.join(queueDir, "task_events.jsonl");

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

function readEvents() {
  if (!fs.existsSync(eventsFile)) return [];
  const raw = fs.readFileSync(eventsFile, "utf8");
  if (!raw.trim()) return [];
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      continue;
    }
  }
  return events;
}

function resolveLatestRunnableTaskId() {
  const events = readEvents();
  const state = new Map();

  for (const ev of events) {
    const id = String(ev.taskId);
    if (!state.has(id)) state.set(id, []);
    state.get(id).push(ev);
  }

  const runnable = [];
  for (const [taskId, evs] of state.entries()) {
    const hasDryRun = evs.some((e) => e.event === "dry_run_ready");
    const hasApproved = evs.some((e) => e.event === "approved");
    const hasDone = evs.some((e) => e.event === "done");
    const hasError = evs.some((e) => e.event === "error");
    if (hasDryRun && !hasApproved && !hasDone && !hasError) {
      const lastDry = evs.filter((e) => e.event === "dry_run_ready").pop();
      const ts = lastDry?.ts || "";
      runnable.push({ taskId, ts });
    }
  }

  runnable.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return runnable.length > 0 ? runnable[0].taskId : null;
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
    if (!APPROVER_CHAT_IDS.has(chatId)) {
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
    if (!APPROVER_CHAT_IDS.has(chatId)) {
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
    if (!APPROVER_CHAT_IDS.has(chatId)) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    touchFile(pauseFlag);
    await sendMessage(chatId, "Queue paused");
    return true;
  }

  if (trimmed === "/resume") {
    if (!APPROVER_CHAT_IDS.has(chatId)) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    if (fs.existsSync(pauseFlag)) fs.unlinkSync(pauseFlag);
    await sendMessage(chatId, "Queue resumed");
    return true;
  }

  if (trimmed === "/disable_executor") {
    if (!APPROVER_CHAT_IDS.has(chatId)) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    touchFile(executorDisabledFlag);
    await sendMessage(chatId, "Executor disabled");
    return true;
  }

  if (trimmed === "/enable_executor") {
    if (!APPROVER_CHAT_IDS.has(chatId)) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    if (fs.existsSync(executorDisabledFlag)) fs.unlinkSync(executorDisabledFlag);
    await sendMessage(chatId, "Executor enabled");
    return true;
  }

  if (trimmed === "#run") {
    if (!APPROVER_CHAT_IDS.has(chatId)) {
      await sendMessage(chatId, "Not authorized");
      return true;
    }
    const taskId = resolveLatestRunnableTaskId();
    if (!taskId) {
      await sendMessage(chatId, "No runnable dry-run task found");
      return true;
    }
    appendEvent({ taskId, event: "approved", by: "operator", meta: { chatId } });
    await sendMessage(chatId, `Run approved #${taskId}`);
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
