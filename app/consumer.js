// /opt/openclaw/gateway/app/consumer.js
console.log("Task Consumer started");
const fs = require("fs");
const path = require("path");
const { appendEvent } = require("./appendEvent");
const {
  runDryRun,
  runInteractiveChat,
  runClassify,
  createCommit,
  pushCommit,
  cleanupWorkspace
} = require("./executor");
const { touchSessionsFile, loadSession, appendHistory, setPendingSwitch } = require("./sessions");

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
  touchSessionsFile();
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

function getEvent(events, name) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === name) return events[i];
  }
  return null;
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

async function consumeOneFIFO() {
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

  if (task.intent === "unknown") {
    notifyTelegram("⚠️ Unknown task intent. Уточните формулировку.", task.chatId).catch(() => {});
    appendEvent({ taskId: task.id, event: "error", by: "executor", meta: { reason: "unknown_intent" } });
    archiveTask(task);
    popHead(lines);
    writeStatus({
      state: "error",
      ts: new Date().toISOString(),
      task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
      error: "unknown_intent",
    });
    console.log(`error task ${task.id}: unknown_intent`);
    return;
  }

  if (task.intent === "interactive_chat" || task.intent === "classify_or_chat") {
    try {
      const session = loadSession(task.chatId) || { history: [] };
      const history = Array.isArray(session.history) ? session.history.slice(-12) : [];

      appendEvent({
        taskId: task.id,
        event: "ai_requested",
        by: "executor",
        meta: { model: process.env.OPENAI_MODEL || "gpt-5.2-codex", intent: task.intent }
      });

      let result = null;
      if (task.intent === "interactive_chat") {
        result = await runInteractiveChat(task, history);
      } else {
        result = await runClassify(task, history);
      }

      appendEvent({
        taskId: task.id,
        event: "ai_response_received",
        by: "executor",
        meta: { model: result?.model || (process.env.OPENAI_MODEL || "gpt-5.2-codex"), responseId: result?.responseId || "" }
      });

      const replyText = result?.reply || "Ок.";
      notifyTelegram(replyText, task.chatId).catch(() => {});
      appendHistory(task.chatId, [
        { role: "user", content: task.text || "" },
        { role: "assistant", content: replyText }
      ]);

      if (result?.switchIntent === "code_change" || result?.intent === "code_change") {
        setPendingSwitch(task.chatId, {
          intent: "code_change",
          taskText: task.text || "",
          ts: new Date().toISOString()
        });
      }

      appendEvent({ taskId: task.id, event: "done", by: "executor", meta: { interactive: true } });
      archiveTask(task);
      popHead(lines);

      writeStatus({
        state: "done",
        ts: new Date().toISOString(),
        task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
        result: "interactive_chat"
      });
      console.log(`done task ${task.id}`);
      return;
    } catch (err) {
      const reason = err?.message || String(err);
      appendEvent({ taskId: task.id, event: "error", by: "executor", meta: { reason } });
      if (reason.startsWith("OpenAI API error:")) {
        notifyTelegram(`❌ Codex error: ${reason}`, task.chatId).catch(() => {});
      } else {
        notifyTelegram(`❌ Error #${task.id}: ${reason}`, task.chatId).catch(() => {});
      }
      archiveTask(task);
      popHead(lines);
      writeStatus({
        state: "error",
        ts: new Date().toISOString(),
        task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
        error: reason
      });
      console.log(`error task ${task.id}: ${reason}`);
      return;
    }
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
      meta: { summary: "AI plan generated" }
    });
  }

  let dryRunResult = null;

  if (!hasEvent(events, "workspace_ready") || !hasEvent(events, "diff_generated") || !hasEvent(events, "dry_run_ready")) {
    appendEvent({
      taskId: task.id,
      event: "ai_requested",
      by: "executor",
      meta: { model: process.env.OPENAI_MODEL || "gpt-5.2-codex" }
    });
    dryRunResult = await runDryRun(task);
    appendEvent({
      taskId: task.id,
      event: "ai_response_received",
      by: "executor",
      meta: {
        model: dryRunResult?.model || (process.env.OPENAI_MODEL || "gpt-5.2-codex"),
        responseId: dryRunResult?.responseId || "",
        ms: dryRunResult?.aiMs || 0
      }
    });
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
    if (dryRunResult?.policyViolations && dryRunResult.policyViolations.length > 0) {
      appendEvent({
        taskId: task.id,
        event: "policy_violation",
        by: "executor",
        meta: { files: dryRunResult.policyViolations }
      });
      appendEvent({
        taskId: task.id,
        event: "error",
        by: "executor",
        meta: { reason: "blocked by policy" }
      });
      notifyTelegram(`❌ Blocked by policy #${task.id}`, task.chatId).catch(() => {});

      archiveTask(task);
      popHead(lines);

      writeStatus({
        state: "error",
        ts: new Date().toISOString(),
        task: { id: task.id, author: task.author, text: task.text, chatId: task.chatId },
        error: "blocked by policy"
      });
      console.log(`error task ${task.id}: blocked by policy`);
      return;
    }

    appendEvent({
      taskId: task.id,
      event: "ai_applied",
      by: "executor",
      meta: { files: dryRunResult?.files || [] }
    });

    appendEvent({
      taskId: task.id,
      event: "dry_run_ready",
      by: "executor",
      meta: {
        summary: dryRunResult?.summary || "Dry-run ready",
        files: dryRunResult?.files || [],
        additions: dryRunResult?.additions || 0,
        deletions: dryRunResult?.deletions || 0,
        noChanges: dryRunResult?.noChanges || false
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
        deletions: dryRunResult?.deletions || 0,
        noChanges: dryRunResult?.noChanges || false
      }
    });

    return;
  }

  if (!hasEvent(events, "approved")) {
    return;
  }

  try {
    if (hasEvent(events, "dry_run_ready")) {
      const dryRunEvent = getEvent(events, "dry_run_ready");
      if (dryRunEvent?.meta?.noChanges) {
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

    let commitInfo = null;
    if (!hasEvent(events, "commit_created")) {
      commitInfo = createCommit(task);
      appendEvent({
        taskId: task.id,
        event: "commit_created",
        by: "executor",
        meta: { commit: commitInfo.commitHash }
      });
      notifyTelegram(`✅ Commit created #${task.id}\n${commitInfo.commitHash}`, task.chatId).catch(() => {});
    }

    if (!hasEvent(events, "pushed")) {
      try {
        const pushInfo = pushCommit(task);
        appendEvent({
          taskId: task.id,
          event: "pushed",
          by: "executor",
          meta: { commit: pushInfo.commitHash }
        });
        const dryRunEvent = getEvent(events, "dry_run_ready");
        const files = dryRunEvent?.meta?.files || commitInfo?.files || [];
        const filesText = files.length > 0 ? files.map((f) => ` - ${f}`).join("\n") : " - (no files)";
        notifyTelegram(`✅ Изменения запушены в main. Изменённые файлы:\n${filesText}`, task.chatId).catch(() => {});
      } catch (err) {
        const reason = err?.message || String(err);
        throw new Error(`push_failed: ${reason}`);
      }
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
      if (reason.startsWith("OpenAI API error:")) {
        notifyTelegram(`❌ Codex error: ${reason}`, task.chatId).catch(() => {});
      } else if (reason.startsWith("push_failed: ")) {
        notifyTelegram(`❌ Ошибка при пуше: ${reason.replace("push_failed: ", "")}`, task.chatId).catch(() => {});
      } else {
        notifyTelegram(`❌ Error #${task.id}: ${reason}`, task.chatId).catch(() => {});
      }
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
      await consumeOneFIFO();
    } catch (err) {
      const reason = err?.message || String(err);
      console.log(`error task unknown: ${reason}`);
    }
    await sleep(1500);
  }
}

consumeLoop();
