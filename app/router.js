const fs = require("fs");
const path = require("path");
const { appendEvent } = require("./appendEvent");
const { loadSession, clearPendingSwitch } = require("./sessions");

const queueDir = path.join(__dirname, "..", "queue");
const counterFile = path.join(queueDir, "counter.txt");
const tasksFile = path.join(queueDir, "tasks.jsonl");
const ADMIN_CHAT_IDS = new Set([351234246, 306786415]);

function nextId() {
  fs.mkdirSync(queueDir, { recursive: true });

  let counter = 0;
  if (fs.existsSync(counterFile)) {
    counter = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0;
  }

  counter += 1;
  fs.writeFileSync(counterFile, String(counter), "utf8");

  return `${counter}`;
}

function routeIncomingMessage(msg) {
  const id = nextId();
  let text = msg.text || "";
  const isAdmin = ADMIN_CHAT_IDS.has(Number(msg.chatId));
  const session = loadSession(msg.chatId);
  const pendingSwitch = session?.pendingSwitch;

  let intent = "unknown";
  if (pendingSwitch && text.trim().length > 0) {
    const normalized = text.trim().toLowerCase();
    const yesWords = new Set(["да", "ок", "okay", "ok", "yes", "y", "ага", "окей"]);
    if (yesWords.has(normalized)) {
      intent = "code_change";
      if (pendingSwitch?.taskText) {
        text = pendingSwitch.taskText;
      }
      clearPendingSwitch(msg.chatId);
    } else {
      clearPendingSwitch(msg.chatId);
    }
  }

  if (intent === "unknown" && text.trim().length > 0 && isAdmin) {
    const normalized = text.toLowerCase();
    const patterns = [
      "поменяй",
      "измен",
      "добав",
      "удал",
      "удали",
      "создай",
      "создать",
      "исправ",
      "обнов",
      "добавь",
      "удалить",
      "create",
      "add",
      "remove",
      "delete",
      "change",
      "update",
      "fix",
    ];
    if (patterns.some((p) => normalized.includes(p))) {
      intent = "code_change";
    }
  }

  if (intent === "unknown" && text.trim().length > 0) {
    intent = "classify_or_chat";
  }

  const task = {
    id,
    source: msg.source,
    chatId: msg.chatId,
    author: msg.author,
    text,
    ts: new Date().toISOString(),
    intent,
    project: "openclaw",
    payload: {
      rawText: text,
      pendingSwitch: pendingSwitch || null
    }
  };

  fs.appendFileSync(tasksFile, JSON.stringify(task) + "\n", "utf8");
  appendEvent({
    taskId: task.id,
    event: "accepted",
    by: "gateway",
    meta: { source: task.source, chatId: task.chatId }
  });

  return task;
}

module.exports = { routeIncomingMessage };
