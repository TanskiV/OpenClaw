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

  const workspaceRoot = getWorkspaceRoot();
  const workspaceDir = getWorkspacePath(task.id);

  fs.mkdirSync(workspaceRoot, { recursive: true });
  if (fs.existsSync(workspaceDir)) {
    return { workspaceDir, repoUrl, repoBranch };
  }

  run(`git clone --depth 1 --branch ${repoBranch} ${repoUrl} ${workspaceDir}`);
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

function runDryRun(task) {
  const policy = loadPolicy();
  const { workspaceDir } = ensureWorkspace(task);

  const diffInfo = getDiffInfo(workspaceDir);
  const noChanges = diffInfo.files.length === 0;
  if (diffInfo.files.length > 0) {
    validatePaths(diffInfo.files, policy);
  }

  const summary = noChanges
    ? "No changes generated (dry-run stub)"
    : `Changes: ${diffInfo.files.length} files`;

  return {
    workspaceDir,
    summary,
    files: diffInfo.files,
    additions: diffInfo.additions,
    deletions: diffInfo.deletions,
    noChanges
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

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is missing");
  }

  const authUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);
  run(`git remote set-url origin ${authUrl}`, { cwd: workspaceDir });
  run(`git push origin HEAD:${repoBranch}`, { cwd: workspaceDir });

  const commitHash = run("git rev-parse HEAD", { cwd: workspaceDir }).trim();
  return { commitHash };
}

function cleanupWorkspace(task) {
  const workspaceDir = getWorkspacePath(task.id);
  if (!fs.existsSync(workspaceDir)) return;
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}

module.exports = { runDryRun, createCommit, pushCommit, cleanupWorkspace, getWorkspacePath };
