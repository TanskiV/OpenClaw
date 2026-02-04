const fs = require("fs");
const path = require("path");

const policyFile = path.join(__dirname, "..", "config", "policy.json");

function splitEnvList(value) {
  if (!value) return null;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadPolicy() {
  let policy = { allowlist: [], denylist: [], repo: {} };
  if (fs.existsSync(policyFile)) {
    try {
      policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    } catch (err) {
      throw new Error(`failed to read policy.json: ${err?.message || err}`);
    }
  }

  const allowlistEnv = splitEnvList(process.env.POLICY_ALLOWLIST || process.env.ALLOWLIST_PATHS);
  const denylistEnv = splitEnvList(process.env.POLICY_DENYLIST || process.env.DENYLIST_PATHS);

  if (allowlistEnv && allowlistEnv.length > 0) {
    policy.allowlist = allowlistEnv;
  }
  if (denylistEnv && denylistEnv.length > 0) {
    policy.denylist = denylistEnv;
  }

  const repoUrl = process.env.TARGET_REPO_URL;
  const repoBranch = process.env.TARGET_REPO_BRANCH;
  if (repoUrl) {
    policy.repo = policy.repo || {};
    policy.repo.url = repoUrl;
  }
  if (repoBranch) {
    policy.repo = policy.repo || {};
    policy.repo.branch = repoBranch;
  }

  return policy;
}

function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

function matchRule(pathValue, rule) {
  if (!rule) return false;
  if (rule.includes("*")) {
    const prefix = rule.split("*")[0];
    return pathValue.startsWith(prefix);
  }
  return pathValue === rule || pathValue.startsWith(rule);
}

function isDenied(filePath, denylist) {
  const normalized = normalizePath(filePath);
  return denylist.some((rule) => matchRule(normalized, rule));
}

function isAllowed(filePath, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const normalized = normalizePath(filePath);
  return allowlist.some((rule) => matchRule(normalized, rule));
}

function validatePaths(files, policy) {
  const allowlist = policy.allowlist || [];
  const denylist = policy.denylist || [];

  const violations = [];
  for (const file of files) {
    if (isDenied(file, denylist) || !isAllowed(file, allowlist)) {
      violations.push(file);
    }
  }

  if (violations.length > 0) {
    throw new Error(`policy violation: ${violations.join(", ")}`);
  }
}

module.exports = { loadPolicy, validatePaths };
