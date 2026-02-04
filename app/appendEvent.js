const fs = require("fs");
const path = require("path");

function appendEvent({ taskId, event, by, meta = {} }) {
  const file = path.join(__dirname, "..", "queue", "task_events.jsonl");
  const row = {
    ts: new Date().toISOString(),
    taskId: String(taskId),
    event,
    by,
    meta
  };
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

module.exports = { appendEvent };
