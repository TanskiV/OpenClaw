const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { loadPolicy, validatePaths } = require("./policy");

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString("utf8");
}

function getWorkspaceRoot() {
  return process.env.WORKSPACE_ROOT || "/opt/openclaw/workspaces";
}

function getWorkspacePath(taskId) {
  return path.join(getWorkspaceRoot(), String(taskId));
}

function ensureWorkspace(task) {
  const policy = loadPolicy();
  const repoUrl = policy.repo?.url || "https://github.com/TanskiV/tanski-job-agent.git";
  const repoBranch = policy.repo?.branch || "main";
  const token = process.env.TARGET_GITHUB_TOKEN;

  const workspaceRoot = getWorkspaceRoot();
  const workspaceDir = getWorkspacePath(task.id);

  fs.mkdirSync(workspaceRoot, { recursive: true });
  if (fs.existsSync(workspaceDir)) {
    return { workspaceDir, repoUrl, repoBranch };
  }

  const cloneUrl = token
    ? repoUrl.replace("https://", `https://x-access-token:${token}@`)
    : repoUrl;
  run(`git clone --depth 1 --branch ${repoBranch} ${cloneUrl} ${workspaceDir}`);
  if (token) {
    run(`git remote set-url origin ${repoUrl}`, { cwd: workspaceDir });
  }
  return { workspaceDir, repoUrl, repoBranch };
}

function parseStatusLines(output) {
  const files = new Set();
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const raw = line.slice(3).trim();
    if (!raw) continue;
    if (raw.includes(" -> ")) {
      const parts = raw.split(" -> ");
      files.add(parts[parts.length - 1]);
    } else {
      files.add(raw);
    }
  }
  return Array.from(files);
}

function getDiffInfo(workspaceDir) {
  const statusOutput = run("git status --porcelain", { cwd: workspaceDir });
  const files = parseStatusLines(statusOutput);

  const numstat = run("git diff --numstat", { cwd: workspaceDir });
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [add, del] = line.split("\t");
    additions += parseInt(add, 10) || 0;
    deletions += parseInt(del, 10) || 0;
  }

  return { files, additions, deletions };
}

function isSafePath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (normalized.includes("..")) return false;
  return true;
}

function buildRepoTree(workspaceDir, limit = 60) {
  const entries = run("git ls-tree --name-only HEAD", { cwd: workspaceDir })
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return entries.slice(0, limit);
}

function readFileSnippet(workspaceDir, relativePath, maxBytes) {
  const fullPath = path.join(workspaceDir, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const buf = fs.readFileSync(fullPath);
  return buf.slice(0, maxBytes).toString("utf8");
}

function buildContext(workspaceDir, policy, taskText) {
  const tree = buildRepoTree(workspaceDir);

  const filesToRead = [
    "README.md",
    "frontend/README.md",
    "backend/README.md",
  ];

  const snippets = [];
  const maxBytesPerFile = 8000;
  for (const file of filesToRead) {
    const content = readFileSnippet(workspaceDir, file, maxBytesPerFile);
    if (content) {
      snippets.push({ file, content });
    }
  }

  const context = {
    repoTree: tree,
    allowlist: policy.allowlist || [],
    denylist: policy.denylist || [],
    task: taskText || "",
    snippets,
  };

  return context;
}

function buildPrompt(context) {
  const system = [
    "You are a senior software engineer working in a constrained repo.",
    "Follow all policy rules strictly.",
    "Only modify files within allowlist.",
    "Never modify files in denylist.",
    "Make minimal, relevant changes only.",
    "Output JSON only, matching the provided schema.",
  ].join("\n");

  const user = [
    "Task:",
    context.task,
    "\nRepo tree (top level):",
    context.repoTree.join("\n"),
    "\nAllowlist paths:",
    context.allowlist.join(", ") || "(none)",
    "\nDenylist paths:",
    context.denylist.join(", ") || "(none)",
    "\nFile snippets:",
    ...context.snippets.map((s) => `--- ${s.file}\n${s.content}`),
    "\nReturn edits as JSON. If no changes are needed, return an empty edits array and a brief summary.",
  ].join("\n");

  return { system, user };
}

function extractOutputText(response) {
  if (response.output_text) return response.output_text;
  if (!response.output || !Array.isArray(response.output)) return "";
  let combined = "";
  for (const item of response.output) {
    const content = item.content || [];
    for (const part of content) {
      if (part.type === "output_text" || part.type === "text") {
        combined += part.text || "";
      }
    }
  }
  return combined;
}

function buildTextFormat(name, schema) {
  return {
    format: {
      type: "json_schema",
      name,
      schema,
      strict: true
    }
  };
}

function buildChatInput(system, history, user) {
  const input = [];
  input.push({ role: "system", content: [{ type: "input_text", text: system }] });
  for (const item of history || []) {
    if (!item || !item.role || !item.content) continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    input.push({ role, content: [{ type: "input_text", text: item.content }] });
  }
  input.push({ role: "user", content: [{ type: "input_text", text: user }] });
  return input;
}

async function callOpenAI({ system, user, history, schemaName, schema }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.2-codex";

  const payload = {
    model,
    input: buildChatInput(system, history, user),
    text: buildTextFormat(schemaName, schema)
  };

  const reasoning = process.env.OPENAI_REASONING_EFFORT;
  if (reasoning) {
    payload.reasoning = { effort: reasoning };
  }

  const verbosity = process.env.OPENAI_VERBOSITY;
  if (verbosity) {
    payload.text.verbosity = verbosity;
  }

  const maxTokens = process.env.OPENAI_MAX_OUTPUT_TOKENS;
  if (maxTokens) {
    payload.max_output_tokens = Number(maxTokens);
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return { data, model };
}

function parseEdits(outputText) {
  if (!outputText) {
    throw new Error("empty model output");
  }

  let parsed = null;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    const start = outputText.indexOf("{");
    const end = outputText.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      parsed = JSON.parse(outputText.slice(start, end + 1));
    } else {
      throw err;
    }
  }

  return parsed;
}

function applyEdits(workspaceDir, edits) {
  for (const edit of edits) {
    if (!edit || typeof edit.path !== "string" || !isSafePath(edit.path)) {
      throw new Error("invalid edit path");
    }
    const normalized = edit.path.replace(/\\/g, "/");
    const fullPath = path.join(workspaceDir, normalized);

    if (edit.action === "delete") {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
      continue;
    }

    if (edit.action === "write") {
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, edit.content || "", "utf8");
      continue;
    }

    throw new Error(`unknown edit action: ${edit.action}`);
  }
}

async function runDryRun(task) {
  const policy = loadPolicy();
  const { workspaceDir } = ensureWorkspace(task);

  const context = buildContext(workspaceDir, policy, task.text || "");
  const { system, user } = buildPrompt(context);
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            action: { type: "string", enum: ["write", "delete"] },
            content: { type: "string" }
          },
          required: ["path", "action", "content"]
        }
      }
    },
    required: ["summary", "edits"]
  };

  const aiStart = Date.now();
  const { data, model } = await callOpenAI({ system, user, history: [], schemaName: "code_changes", schema });
  const aiMs = Date.now() - aiStart;

  const outputText = extractOutputText(data);
  const parsed = parseEdits(outputText);
  const edits = Array.isArray(parsed.edits) ? parsed.edits : [];

  const filesTouched = edits
    .map((e) => e.path)
    .filter((p) => typeof p === "string")
    .map((p) => p.replace(/\\/g, "/"));

  const policyViolations = [];
  for (const file of filesTouched) {
    if (!isSafePath(file)) {
      policyViolations.push(file);
    }
  }

  if (policyViolations.length === 0) {
    try {
      validatePaths(filesTouched, policy);
    } catch (err) {
      policyViolations.push(...filesTouched);
    }
  }

  if (policyViolations.length > 0) {
    return {
      summary: parsed.summary || "Blocked by policy",
      files: filesTouched,
      additions: 0,
      deletions: 0,
      noChanges: true,
      policyViolations,
      responseId: data.id,
      model,
      aiMs
    };
  }

  applyEdits(workspaceDir, edits);

  const diffInfo = getDiffInfo(workspaceDir);
  const noChanges = diffInfo.files.length === 0;

  const summary = parsed.summary || (noChanges ? "No changes generated" : `Changes: ${diffInfo.files.length} files`);

  return {
    summary,
    files: diffInfo.files,
    additions: diffInfo.additions,
    deletions: diffInfo.deletions,
    noChanges,
    policyViolations: [],
    responseId: data.id,
    model,
    aiMs
  };
}

async function runInteractiveChat(task, history) {
  const policy = loadPolicy();
  const { workspaceDir } = ensureWorkspace(task);
  const context = buildContext(workspaceDir, policy, task.text || "");

  const system = [
    "You are a helpful engineer answering questions about this project.",
    "Do not generate code patches.",
    "If a code change is clearly requested, set switch_intent to code_change and ask for confirmation.",
    "Respond with concise guidance.",
  ].join("\n");

  const user = [
    "User message:",
    context.task,
    "",
    "Repo tree (top level):",
    context.repoTree.join("\n"),
    "",
    "Allowlist paths:",
    context.allowlist.join(", ") || "(none)",
    "",
    "Denylist paths:",
    context.denylist.join(", ") || "(none)",
    "",
    "File snippets:",
    ...context.snippets.map((s) => `--- ${s.file}\n${s.content}`),
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string" },
      follow_up: { type: ["string", "null"] },
      switch_intent: { type: ["string", "null"], enum: ["code_change", "interactive_chat", null] }
    },
    required: ["reply", "follow_up", "switch_intent"]
  };

  const aiStart = Date.now();
  const { data, model } = await callOpenAI({
    system,
    user,
    history,
    schemaName: "interactive_chat",
    schema
  });
  const aiMs = Date.now() - aiStart;
  const outputText = extractOutputText(data);
  const parsed = parseEdits(outputText);

  return {
    reply: parsed.reply || "",
    followUp: parsed.follow_up || null,
    switchIntent: parsed.switch_intent || null,
    responseId: data.id,
    model,
    aiMs
  };
}

async function runClassify(task, history) {
  const policy = loadPolicy();
  const { workspaceDir } = ensureWorkspace(task);
  const context = buildContext(workspaceDir, policy, task.text || "");

  const system = [
    "You classify whether the message requires a code change.",
    "Return intent as code_change or interactive_chat.",
    "If you recommend code_change, set switch_intent to code_change and ask for confirmation in reply.",
  ].join("\n");

  const user = [
    "User message:",
    context.task,
    "",
    "Repo tree (top level):",
    context.repoTree.join("\n"),
    "",
    "Allowlist paths:",
    context.allowlist.join(", ") || "(none)",
    "",
    "Denylist paths:",
    context.denylist.join(", ") || "(none)",
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string", enum: ["interactive_chat", "code_change"] },
      reply: { type: "string" },
      follow_up: { type: ["string", "null"] },
      switch_intent: { type: ["string", "null"], enum: ["code_change", "interactive_chat", null] }
    },
    required: ["intent", "reply", "follow_up", "switch_intent"]
  };

  const aiStart = Date.now();
  const { data, model } = await callOpenAI({
    system,
    user,
    history,
    schemaName: "classify_or_chat",
    schema
  });
  const aiMs = Date.now() - aiStart;
  const outputText = extractOutputText(data);
  const parsed = parseEdits(outputText);

  return {
    intent: parsed.intent || "interactive_chat",
    reply: parsed.reply || "",
    followUp: parsed.follow_up || null,
    switchIntent: parsed.switch_intent || null,
    responseId: data.id,
    model,
    aiMs
  };
}

function createCommit(task) {
  const policy = loadPolicy();
  const { workspaceDir } = ensureWorkspace(task);

  const diffInfo = getDiffInfo(workspaceDir);
  if (diffInfo.files.length === 0) {
    throw new Error("no changes to commit");
  }
  validatePaths(diffInfo.files, policy);

  run("git add -A", { cwd: workspaceDir });
  run("git config user.name \"OpenClaw Bot\"", { cwd: workspaceDir });
  run("git config user.email \"openclaw-bot@users.noreply.github.com\"", { cwd: workspaceDir });

  const message = `OpenClaw: task ${task.id}`;
  run(`git commit -m \"${message}\"`, { cwd: workspaceDir });

  const commitHash = run("git rev-parse HEAD", { cwd: workspaceDir }).trim();
  return { commitHash, files: diffInfo.files, additions: diffInfo.additions, deletions: diffInfo.deletions };
}

function pushCommit(task) {
  const policy = loadPolicy();
  const { workspaceDir, repoBranch, repoUrl } = ensureWorkspace(task);

  const token = process.env.TARGET_GITHUB_TOKEN;
  if (!token) {
    throw new Error("TARGET_GITHUB_TOKEN is missing");
  }

  const authUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);
  run(`git remote set-url origin ${authUrl}`, { cwd: workspaceDir });
  run(`git push origin HEAD:${repoBranch}`, { cwd: workspaceDir });
  run(`git remote set-url origin ${repoUrl}`, { cwd: workspaceDir });

  const commitHash = run("git rev-parse HEAD", { cwd: workspaceDir }).trim();
  return { commitHash };
}

function cleanupWorkspace(task) {
  const workspaceDir = getWorkspacePath(task.id);
  if (!fs.existsSync(workspaceDir)) return;
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}

module.exports = {
  runDryRun,
  runInteractiveChat,
  runClassify,
  createCommit,
  pushCommit,
  cleanupWorkspace,
  getWorkspacePath
};
