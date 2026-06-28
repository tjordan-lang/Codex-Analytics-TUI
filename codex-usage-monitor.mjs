#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const ARCHIVE_DIR = path.join(os.homedir(), ".codex", "archived_sessions");
const REFRESH_MS = Number(process.env.CODEX_USAGE_REFRESH_MS || 5000);
let recentSnapshotKey = "";
let recentSnapshotRows = [];
const recentTokenCache = new Map();

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function color(text, code) {
  return `${code}${text}${ansi.reset}`;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function padVisible(text, width) {
  const visible = stripAnsi(text).length;
  return text + " ".repeat(Math.max(0, width - visible));
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Number(n || 0));
}

function localMidnightEpoch() {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
}

function formatDateTime(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString();
}

function countdown(ts) {
  const ms = Math.max(0, ts * 1000 - Date.now());
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function gauge(percent, width = 24) {
  const p = Math.max(0, Math.min(100, Number(percent || 0)));
  const filled = Math.round((p / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function remainingPercent(usedPercent) {
  return Math.max(0, Math.min(100, 100 - Number(usedPercent || 0)));
}

function gaugeColor(percent) {
  const remaining = remainingPercent(percent);
  if (remaining <= 10) return ansi.red;
  if (remaining <= 25) return ansi.yellow;
  if (remaining <= 50) return ansi.cyan;
  return ansi.green;
}

function usedGaugeColor(percent) {
  if (percent >= 90) return ansi.red;
  if (percent >= 70) return ansi.yellow;
  if (percent >= 40) return ansi.cyan;
  return ansi.green;
}

function walkJsonlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      out.push(...walkJsonlFiles(entryPath));
    } else if (entry.endsWith(".jsonl")) {
      out.push(entryPath);
    }
  }
  return out;
}

function latestThreadId() {
  try {
    const raw = query("select id from threads order by updated_at desc limit 1;");
    return raw.trim();
  } catch {
    return "";
  }
}

function extractRateLimits(record) {
  return record?.payload?.rate_limits || record?.payload?.info?.rate_limits || null;
}

function sessionThreadId(file) {
  try {
    const firstLine = fs.readFileSync(file, "utf8").split("\n", 1)[0];
    if (!firstLine) return "";
    const record = JSON.parse(firstLine);
    if (record?.type !== "session_meta") return "";
    return record?.payload?.parent_thread_id || record?.payload?.id || "";
  } catch {
    return "";
  }
}

function sessionFilesForThread(threadId) {
  const files = [...walkJsonlFiles(SESSIONS_DIR), ...walkJsonlFiles(ARCHIVE_DIR)];
  if (!threadId) return files;
  return files.filter((file) => sessionThreadId(file) === threadId);
}

function latestRateLimitSnapshot(threadId) {
  const files = sessionFilesForThread(threadId);
  let latest = null;

  for (const file of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8").trimEnd();
    } catch {
      continue;
    }
    if (!raw) continue;

    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const record = JSON.parse(lines[i]);
        const rateLimits = extractRateLimits(record);
        if (!rateLimits?.primary || !rateLimits?.secondary) continue;

        const ts = record.timestamp ? Math.floor(new Date(record.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
        if (!latest || ts > latest.timestamp) {
          latest = {
            file,
            timestamp: ts,
            rateLimits,
          };
        }
        break;
      } catch {
        // ignore malformed lines
      }
    }
  }

  return latest;
}

function latestTokenCount(threadId) {
  const files = sessionFilesForThread(threadId);
  let latest = null;

  for (const file of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8").trimEnd();
    } catch {
      continue;
    }
    if (!raw) continue;

    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const record = JSON.parse(lines[i]);
        if (record?.payload?.type !== "token_count") continue;
        const info = record.payload.info || {};
        const total = info.total_token_usage || {};
        const ts = record.timestamp ? Math.floor(new Date(record.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
        if (!latest || ts > latest.timestamp) {
          latest = {
            timestamp: ts,
            totalTokens: Number(total.total_tokens || 0),
            cachedTokens: Number(total.cached_input_tokens || 0),
          };
        }
        break;
      } catch {
        // ignore malformed lines
      }
    }
  }

  return latest;
}

function stableRecentRows(recent) {
  const rows = recent.slice(0, 5);
  const key = rows.map((row) => `${row.id}:${row.updatedAt}:${row.tokensUsed}:${row.title}`).join("|");
  if (key !== recentSnapshotKey) {
    recentSnapshotKey = key;
    recentSnapshotRows = rows.map((row) => ({ ...row }));
  }
  return recentSnapshotRows;
}

function query(sql) {
  return execFileSync("sqlite3", ["-readonly", "-separator", "\t", DB_PATH, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function readUsage() {
  const since = localMidnightEpoch();
  const totalAll = Number(query("select coalesce(sum(tokens_used), 0) from threads where archived = 0;") || 0);
  const totalToday = Number(
    query(`select coalesce(sum(tokens_used), 0) from threads where archived = 0 and created_at >= ${since};`) || 0
  );
  const threadId = latestThreadId();
  const recentRaw = query(
    "select id, updated_at, tokens_used, source, model_provider, replace(substr(title, 1, 70), char(9), ' ') from threads where archived = 0 order by updated_at desc limit 5;"
  );

  const recent = recentRaw
    ? recentRaw.split("\n").map((line) => {
        const [id, updatedAt, tokensUsed, source, provider, title] = line.split("\t");
        return {
          id: id || "",
          updatedAt: Number(updatedAt || 0),
          tokensUsed: Number(tokensUsed || 0),
          source: source || "",
          provider: provider || "",
          title: title || "",
        };
      })
    : [];

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    totalToday,
    totalAll,
    recent,
    threadId,
    rate: latestRateLimitSnapshot(threadId),
    error: null,
  };
}

function headerLine(label, value, width = 34) {
  const left = label.padEnd(10);
  const right = value.slice(0, width).padEnd(width);
  return `${color(left, ansi.dim)} ${right}`;
}

function renderHeader(state) {
  const title = "Codex CLI Usage Monitor";
  const status = state.rate ? color("live snapshot", ansi.green) : color("no local rate snapshot", ansi.yellow);
  const source = path.basename(DB_PATH);
  const snapshot = state.rate?.file ? path.basename(state.rate.file) : "";
  const rows = [
    headerLine("updated", formatDateTime(state.updatedAt)),
    headerLine("status", status),
    headerLine("source", source),
  ];
  if (state.threadId) rows.push(headerLine("thread", state.threadId));
  if (snapshot) rows.push(headerLine("snapshot", snapshot));

  const width = 72;
  const top = `┌${"─".repeat(width - 2)}┐`;
  const bottom = `└${"─".repeat(width - 2)}┘`;
  console.log(top);
  console.log(`│ ${padVisible(color(title, ansi.bold + ansi.white), width - 4)} │`);
  console.log(`│ ${" ".repeat(width - 4)} │`);
  for (const row of rows) {
    console.log(`│ ${padVisible(row, width - 4)} │`);
  }
  console.log(bottom);
}

function renderGaugeRow(label, percent, resetsAt) {
  const pct = Number(percent || 0);
  const remaining = remainingPercent(pct);
  const colorCode = gaugeColor(pct);
  const line = `${label.padEnd(4)} ${gauge(remaining)} ${String(remaining.toFixed(0)).padStart(3)}% remaining  resets ${formatDateTime(resetsAt)}`;
  console.log(color(line, colorCode));
}

function buildCard(title, usedPercent, resetsAt) {
  const remaining = remainingPercent(usedPercent);
  const pctColor = gaugeColor(usedPercent);
  const width = 48;
  const body = [
    ` ${title}`,
    ` ${color(`${remaining.toFixed(0)}% remaining`, ansi.bold + ansi.white)}`,
    ` ${color(gauge(remaining, 38), pctColor)}`,
    ` ${color(`Resets ${formatDateTime(resetsAt)}`, ansi.dim)}`,
  ];

  const top = `┌${"─".repeat(width - 2)}┐`;
  const bottom = `└${"─".repeat(width - 2)}┘`;
  const lines = [top];
  for (const line of body) {
    lines.push(`│ ${padVisible(line, width - 4)} │`);
  }
  lines.push(bottom);
  return lines;
}

function renderCards(left, right) {
  const cols = process.stdout.columns || 80;
  const gap = 3;
  const cardWidth = 48;
  if (cols >= cardWidth * 2 + gap) {
    const height = Math.max(left.length, right.length);
    for (let i = 0; i < height; i += 1) {
      const l = padVisible(left[i] || "", cardWidth);
      const r = padVisible(right[i] || "", cardWidth);
      console.log(`${l}${" ".repeat(gap)}${r}`);
    }
    return;
  }

  for (const line of left) console.log(line);
  console.log("");
  for (const line of right) console.log(line);
}

function renderRecent(recent) {
  console.log(color("Recent threads", ansi.bold + ansi.white));
  const rows = stableRecentRows(recent);
  if (rows.length === 0) {
    console.log(color("  no local threads yet", ansi.dim));
    return;
  }

  for (const row of rows) {
    const time = color(formatTime(row.updatedAt).padEnd(10), ansi.dim);
    let token = recentTokenCache.get(row.id);
    if (!token || token.updatedAt !== row.updatedAt) {
      token = { updatedAt: row.updatedAt, value: latestTokenCount(row.id) };
      recentTokenCache.set(row.id, token);
    }
    const tokens = color(fmt(token.value?.totalTokens ?? row.tokensUsed).padStart(11), ansi.magenta);
    const scope = color((row.provider || row.source || "").padEnd(6), ansi.cyan);
    const title = row.title || "(untitled)";
    const tokenNote = token.value?.cachedTokens ? color(`(+ ${fmt(token.value.cachedTokens)} cached)`, ansi.dim) : "";
    console.log(`${time} ${tokens} ${scope} ${title}${tokenNote ? ` ${tokenNote}` : ""}`);
  }
}

function render(state) {
  process.stdout.write("\x1b[2J\x1b[H");
  renderHeader(state);
  console.log("");

  if (state.error) {
    console.log(color(`Error: ${state.error}`, ansi.red));
    return;
  }

  if (state.rate?.rateLimits) {
    const fiveH = buildCard("5 hour usage limit", state.rate.rateLimits.primary.used_percent, state.rate.rateLimits.primary.resets_at);
    const weekly = buildCard("Weekly usage limit", state.rate.rateLimits.secondary.used_percent, state.rate.rateLimits.secondary.resets_at);
    renderCards(fiveH, weekly);
  } else {
    console.log(color("Rate limits unavailable in local session logs", ansi.dim));
  }
  console.log("");

  console.log(color("Local usage", ansi.bold + ansi.white));
  console.log(color(`today     ${fmt(state.totalToday).padStart(14)} tokens`, ansi.green));
  console.log(color(`all-time  ${fmt(state.totalAll).padStart(14)} tokens`, ansi.cyan));
  console.log("");

  renderRecent(state.recent.filter((row) => row.updatedAt > 0));
  console.log("");
  console.log(color(`Refresh every ${Math.round(REFRESH_MS / 1000)}s  Ctrl-C to quit`, ansi.dim));
}

function renderKey(state) {
  return JSON.stringify({
    error: state.error,
    totalToday: state.totalToday,
    totalAll: state.totalAll,
    threadId: state.threadId,
    rateTimestamp: state.rate?.timestamp,
    rateLimits: state.rate?.rateLimits,
    recent: state.recent.map((row) => ({
      id: row.id,
      updatedAt: row.updatedAt,
      tokensUsed: row.tokensUsed,
      provider: row.provider,
      source: row.source,
      title: row.title,
    })),
  });
}

async function main() {
  let state = { updatedAt: null, totalToday: 0, totalAll: 0, recent: [], rate: null, error: null };
  let lastRenderKey = "";

  const tick = () => {
    try {
      state = readUsage();
    } catch (err) {
      state = {
        ...state,
        updatedAt: Math.floor(Date.now() / 1000),
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const key = renderKey(state);
    if (key !== lastRenderKey) {
      lastRenderKey = key;
      render(state);
    }
  };

  tick();
  setInterval(tick, REFRESH_MS);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
