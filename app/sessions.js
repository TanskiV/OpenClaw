const fs = require("fs");
const path = require("path");

const queueDir = path.join(__dirname, "..", "queue");
const sessionsFile = path.join(queueDir, "sessions.jsonl");

function touchSessionsFile() {
  fs.mkdirSync(queueDir, { recursive: true });
  if (!fs.existsSync(sessionsFile)) {
    fs.closeSync(fs.openSync(sessionsFile, "a"));
  }
}

function loadAllSessions() {
  touchSessionsFile();
  const raw = fs.readFileSync(sessionsFile, "utf8");
  if (!raw.trim()) return new Map();
  const map = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.chatId != null) {
        map.set(String(row.chatId), row);
      }
    } catch (err) {
      continue;
    }
  }
  return map;
}

function saveAllSessions(map) {
  const lines = [];
  for (const session of map.values()) {
    lines.push(JSON.stringify(session));
  }
  fs.writeFileSync(sessionsFile, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
}

function loadSession(chatId) {
  const map = loadAllSessions();
  return map.get(String(chatId)) || null;
}

function upsertSession(session) {
  const map = loadAllSessions();
  map.set(String(session.chatId), session);
  saveAllSessions(map);
}

function appendHistory(chatId, entries) {
  const session = loadSession(chatId) || { chatId, history: [], lastUpdated: new Date().toISOString() };
  session.history = Array.isArray(session.history) ? session.history : [];
  session.history.push(...entries);
  session.lastUpdated = new Date().toISOString();
  upsertSession(session);
  return session;
}

function setPendingSwitch(chatId, pending) {
  const session = loadSession(chatId) || { chatId, history: [], lastUpdated: new Date().toISOString() };
  session.pendingSwitch = pending;
  session.lastUpdated = new Date().toISOString();
  upsertSession(session);
  return session;
}

function clearPendingSwitch(chatId) {
  const session = loadSession(chatId);
  if (!session) return;
  delete session.pendingSwitch;
  session.lastUpdated = new Date().toISOString();
  upsertSession(session);
}

module.exports = {
  sessionsFile,
  touchSessionsFile,
  loadSession,
  appendHistory,
  setPendingSwitch,
  clearPendingSwitch,
};
