// /opt/openclaw/gateway/app/consumer.js
console.log("Task Consumer started");
const fs = require("fs");
const path = require("path");
const { appendEvent } = require("./appendEvent");
const { runDryRun, createCommit, pushCommit, cleanupWorkspace } = require("./executor");

const queueDir = path.join(__dirname, "..", "queue");
const tasksFile = path.join(queueDir, "tasks.jsonl");
const statusFile = path.join(queueDir, "status.json");
const processedFile = path.join(queueDir, "processed.jsonl");
const eventsFile = path.join(queueDir, "task_events.jsonl");
const pauseFlag = path.join(queueDir, "PAUSE");
const executorDisabledFlag = path.join(queueDir, "EXECUTOR_DISABLED");

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

function readEventsForTask(taskId) {
  if (!fs.existsSync(eventsFile)) return [];
  const raw = fs.readFileSync(eventsFile, "utf8");
  if (!raw.trim()) return [];
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (String(row.taskId) === String(taskId)) {
        events.push(row);
      }
    } catch (err) {
      continue;
    }
  }
  return events;
}

function hasEvent(events, name) {
  return events.some((e) => e.event === name);
}

function writeStatus(s) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify(s, null, 2), "utf8");
}

async function notifyTelegram(text, chatIdOverride) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride || process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), text }),
  });
}

function processedHasTask(taskId) {
  if (!fs.existsSync(processedFile)) return false;
  const raw = fs.readFileSync(processedFile, "utf8");
  if (!raw.trim()) return false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (String(row.id) === String(taskId)) {
        return true;
      }
    } catch (err) {
      continue;
    }
  }
  return false;
}

function archiveTask(task) {
  if (!processedHasTask(task.id)) {
    fs.appendFileSync(processedFile, JSON.stringify(task) + "\n", "utf8");
  }
}

function popHead(lines) {
  const remaining = lines.slice(1);
  fs.writeFileSync(tasksFile, remaining.length > 0 ? remaining.join("\n") + "\n" : "", "utf8");
}

function isPaused() {
  return fs.existsSync(pauseFlag) || process.env.QUEUE_PAUSE === "1";
}

function isExecutorDisabled() {
  return fs.existsSync(executorDisabledFlag) || process.env.EXECUTOR_DISABLED === "1";
}

function consumeOneFIFO() {
  ensureQueueFiles();

  if (isPaused()) {
    writeStatus({ state: "paused", ts: new Date().toISOString() });
    return;
  }
  if (isExecutorDisabled()) {
    writeStatus({ state: "executor_disabled", ts: new Date().toISOString() });
    return;
  }

  const lines = readTaskLines();
  if (lines.length === 0) {
    writeStatus({ state: "idle", ts: new Date().toISOString() });
    return;
  }

  const task = JSON.parse(lines[0]);
  const events = readEventsForTask(task.id);

  if (hasEvent(events, "done") || hasEvent(events, "error")) {
    archiveTask(task);
    popHead(lines);
    return;
  }

  if (!hasEvent(events, "picked")) {
    appendEvent({
      taskId: task.id,
      event: "picked",
      by: "consumer",
      meta: { chatId: task.chatId }
    });
    notifyTelegram(`🟡 Взял задачу #${task.id}`, task.chatId).catch(() => {});
    writeStatus({
      state: "picked",
      ts: new Date().toISOString(),
      task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
    });
    console.log(`picked task ${task.id}: ${task.text}`);
  }

  if (!hasEvent(events, "context_loaded")) {
    appendEvent({ taskId: task.id, event: "context_loaded", by: "executor", meta: {} });
  }

  if (!hasEvent(events, "plan_generated")) {
    appendEvent({
      taskId: task.id,
      event: "plan_generated",
      by: "executor",
      meta: { summary: "Dry-run stub (no AI executor yet)" }
    });
  }

  let dryRunResult = null;

  if (!hasEvent(events, "workspace_ready") || !hasEvent(events, "diff_generated") || !hasEvent(events, "dry_run_ready")) {
    dryRunResult = runDryRun(task);
  }

  if (!hasEvent(events, "workspace_ready")) {
    appendEvent({
      taskId: task.id,
      event: "workspace_ready",
      by: "executor",
      meta: { path: dryRunResult?.workspaceDir || "" }
    });
  }

  if (!hasEvent(events, "diff_generated")) {
    appendEvent({
      taskId: task.id,
      event: "diff_generated",
      by: "executor",
      meta: {
        files: dryRunResult?.files || [],
        additions: dryRunResult?.additions || 0,
        deletions: dryRunResult?.deletions || 0
      }
    });
  }

  if (!hasEvent(events, "dry_run_ready")) {
    appendEvent({
      taskId: task.id,
      event: "dry_run_ready",
      by: "executor",
      meta: {
        summary: dryRunResult?.summary || "Dry-run ready",
        files: dryRunResult?.files || [],
        additions: dryRunResult?.additions || 0,
        deletions: dryRunResult?.deletions || 0
      }
    });

    const filesList = (dryRunResult?.files || []).join(", ") || "(no files)";
    const summaryText = dryRunResult?.summary || "Dry-run ready";
    const delta = `+${dryRunResult?.additions || 0}/-${dryRunResult?.deletions || 0}`;
    notifyTelegram(`📝 Dry-run ready #${task.id}\n${summaryText}\nFiles: ${filesList}\nDelta: ${delta}`, task.chatId).catch(() => {});

    writeStatus({
      state: "dry_run_ready",
      ts: new Date().toISOString(),
      task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
      dryRun: {
        summary: summaryText,
        files: dryRunResult?.files || [],
        additions: dryRunResult?.additions || 0,
        deletions: dryRunResult?.deletions || 0
      }
    });

    return;
  }

  if (!hasEvent(events, "approved")) {
    return;
  }

  try {
    if (hasEvent(events, "dry_run_ready")) {
      if (!dryRunResult) {
        dryRunResult = runDryRun(task);
      }
      if (dryRunResult?.noChanges) {
        appendEvent({ taskId: task.id, event: "noop", by: "executor", meta: {} });
        notifyTelegram(`✅ Done #${task.id} (no changes)`, task.chatId).catch(() => {});
        appendEvent({ taskId: task.id, event: "done", by: "executor", meta: {} });

        archiveTask(task);
        popHead(lines);

        writeStatus({
          state: "done",
          ts: new Date().toISOString(),
          task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
          result: "noop"
        });
        console.log(`done task ${task.id}`);

        cleanupWorkspace(task);
        return;
      }
    }

    if (!hasEvent(events, "commit_created")) {
      const commitInfo = createCommit(task);
      appendEvent({
        taskId: task.id,
        event: "commit_created",
        by: "executor",
        meta: { commit: commitInfo.commitHash }
      });
      notifyTelegram(`✅ Commit created #${task.id}\n${commitInfo.commitHash}`, task.chatId).catch(() => {});
    }

    if (!hasEvent(events, "pushed")) {
      const pushInfo = pushCommit(task);
      appendEvent({
        taskId: task.id,
        event: "pushed",
        by: "executor",
        meta: { commit: pushInfo.commitHash }
      });
      notifyTelegram(`🚀 Pushed #${task.id}`, task.chatId).catch(() => {});
    }

    appendEvent({ taskId: task.id, event: "done", by: "executor", meta: {} });
    notifyTelegram(`✅ Done #${task.id}`, task.chatId).catch(() => {});

    archiveTask(task);
    popHead(lines);

    writeStatus({
      state: "done",
      ts: new Date().toISOString(),
      task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
    });
    console.log(`done task ${task.id}`);

    cleanupWorkspace(task);
  } catch (err) {
    const reason = err?.message || String(err);

    if (!hasEvent(events, "error")) {
      appendEvent({
        taskId: task.id,
        event: "error",
        by: "executor",
        meta: { reason }
      });
      notifyTelegram(`❌ Error #${task.id}: ${reason}`, task.chatId).catch(() => {});
    }

    archiveTask(task);
    popHead(lines);

    writeStatus({
      state: "error",
      ts: new Date().toISOString(),
      task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
      error: reason,
    });
    console.log(`error task ${task.id}: ${reason}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeLoop() {
  while (true) {
    try {
      consumeOneFIFO();
    } catch (err) {
      const reason = err?.message || String(err);
      console.log(`error task unknown: ${reason}`);
    }
    await sleep(1500);
  }
}

consumeLoop();
