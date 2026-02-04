const fs = require("fs");
const path = require("path");
const { appendEvent } = require("./appendEvent");

const queueDir = path.join(__dirname, "..", "queue");
const counterFile = path.join(queueDir, "counter.txt");
const tasksFile = path.join(queueDir, "tasks.jsonl");

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

  const task = {
    id,
    source: msg.source,
    chatId: msg.chatId,
    author: msg.author,
    text: msg.text || "",
    ts: new Date().toISOString(),
    intent: "code_change",
    project: "shefa-green",
    payload: { rawText: msg.text || "" }
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
