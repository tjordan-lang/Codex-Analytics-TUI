#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const ARCHIVE_DIR = path.join(os.homedir(), ".codex", "archived_sessions");
const REFRESH_MS = Number(process.env.CODEX_USAGE_REFRESH_MS || 5000);

// ---------------------------------------------------------------------------
// ANSI primitives
// ---------------------------------------------------------------------------

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  clear: "\x1b[2J",
  clearLine: "\x1b[2K",
  home: "\x1b[H",
  save: "\x1b[s",
  restore: "\x1b[u",
  // 256-color palette: dim/grey tones for chrome.
  grey: "\x1b[38;5;240m",
  greyDim: "\x1b[38;5;238m",
  rule: "\x1b[38;5;236m",
  // Semantic colors.
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;179m",
  red: "\x1b[38;5;174m",
  cyan: "\x1b[38;5;110m",
  magenta: "\x1b[38;5;139m",
  white: "\x1b[38;5;252m",
  muted: "\x1b[38;5;244m",
  accent: "\x1b[38;5;81m",
  accentSoft: "\x1b[38;5;66m",
};

function color(text, code) {
  return code ? `${code}${text}${ansi.reset}` : text;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function visibleLen(text) {
  return stripAnsi(text).length;
}

function padRight(text, width) {
  const v = visibleLen(text);
  return v >= width ? text : text + " ".repeat(width - v);
}

function truncate(text, width) {
  const v = visibleLen(text);
  if (v <= width) return text;
  const ellipsis = "…";
  const keep = width - ellipsis.length;
  if (keep <= 0) return "";
  let kept = 0;
  let out = "";
  let inEscape = false;
  for (const ch of text) {
    if (inEscape) {
      out += ch;
      if (ch >= "a" && ch <= "z") inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      out += ch;
      inEscape = true;
      continue;
    }
    if (kept >= keep) break;
    out += ch;
    kept += 1;
  }
  return out + color(ellipsis, ansi.muted);
}

function goto(row, col = 1) {
  return `\x1b[${row};${col}H`;
}

// ---------------------------------------------------------------------------
// Number / time formatting
// ---------------------------------------------------------------------------

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Number(n || 0));
}

function fmtCompact(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function localMidnightEpoch() {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
}

function formatDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function relativeTime(ts) {
  if (!ts) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function countdown(ts) {
  const ms = Math.max(0, ts * 1000 - Date.now());
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Rate-limit snapshot reading
// ---------------------------------------------------------------------------

function walkJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkJsonlFiles(entryPath, out);
    } else if (entry.endsWith(".jsonl")) {
      out.push(entryPath);
    }
  }
  return out;
}

function latestThreadId() {
  try {
    return query("select id from threads order by updated_at desc limit 1;").trim();
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

function scanTailForFirstMatch(files, predicate) {
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
        const result = predicate(record, file);
        if (!result) continue;
        if (!latest || result.timestamp > latest.timestamp) {
          latest = result;
        }
        break;
      } catch {
        // ignore malformed lines
      }
    }
  }
  return latest;
}

function latestRateLimitSnapshot(threadId) {
  const files = sessionFilesForThread(threadId);
  const latest = scanTailForFirstMatch(files, (record, file) => {
    const rateLimits = extractRateLimits(record);
    if (!rateLimits?.primary || !rateLimits?.secondary) return null;
    const ts = record.timestamp ? Math.floor(new Date(record.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    return { file, timestamp: ts, rateLimits };
  });
  if (!latest) return null;

  const now = Math.floor(Date.now() / 1000);
  const rateLimits = Object.fromEntries(
    Object.entries(latest.rateLimits).map(([name, limit]) => [
      name,
      limit?.resets_at && limit.resets_at <= now ? { ...limit, used_percent: 0 } : limit,
    ])
  );
  return { ...latest, rateLimits };
}

function latestTokenCount(threadId) {
  const files = sessionFilesForThread(threadId);
  return scanTailForFirstMatch(files, (record) => {
    if (record?.payload?.type !== "token_count") return null;
    const info = record.payload.info || {};
    const total = info.total_token_usage || {};
    const ts = record.timestamp ? Math.floor(new Date(record.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    return {
      timestamp: ts,
      totalTokens: Number(total.total_tokens || 0),
      cachedTokens: Number(total.cached_input_tokens || 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Token cache (avoids re-reading session JSONL files on every tick)
// ---------------------------------------------------------------------------

const recentTokenCache = new Map();

function cachedTokenCount(id, updatedAt) {
  let cached = recentTokenCache.get(id);
  if (cached && cached.updatedAt === updatedAt) return cached.value;
  const tk = latestTokenCount(id);
  cached = { updatedAt, value: tk };
  recentTokenCache.set(id, cached);
  return tk;
}

// ---------------------------------------------------------------------------
// sqlite wrapper
// ---------------------------------------------------------------------------

function query(sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-separator", "\t", DB_PATH, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trimEnd();
}

function readUsage() {
  const since = localMidnightEpoch();
  const totalAll = Number(query("select coalesce(sum(tokens_used), 0) from threads where archived = 0;") || 0);
  const totalToday = Number(
    query(`select coalesce(sum(tokens_used), 0) from threads where archived = 0 and created_at >= ${since};`) || 0
  );
  const threadCount = Number(query("select count(*) from threads where archived = 0;") || 0);
  const threadId = latestThreadId();
  const recentRaw = query(
    "select id, updated_at, tokens_used, source, model_provider, model, replace(substr(title, 1, 80), char(9), ' ') from threads where archived = 0 order by updated_at desc limit 6;"
  );

  const recent = recentRaw
    ? recentRaw.split("\n").map((line) => {
        const [id, updatedAt, tokensUsed, source, provider, model, title] = line.split("\t");
        return {
          id: id || "",
          updatedAt: Number(updatedAt || 0),
          tokensUsed: Number(tokensUsed || 0),
          source: source || "",
          provider: provider || "",
          model: model || "",
          title: title || "",
        };
      })
    : [];

  // Fetch token totals for each recent thread (uses cache to avoid re-reading
  // session JSONL files for rows whose updatedAt hasn't changed).
  recent.forEach((row) => {
    if (!row.id) return;
    const tk = cachedTokenCount(row.id, row.updatedAt);
    if (tk) {
      row.totalTokens = tk.totalTokens;
      row.cachedTokens = tk.cachedTokens;
      row.tokenTs = tk.timestamp;
    } else {
      row.totalTokens = row.tokensUsed;
      row.cachedTokens = 0;
      row.tokenTs = row.updatedAt;
    }
  });

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    totalToday,
    totalAll,
    threadCount,
    recent,
    threadId,
    rate: latestRateLimitSnapshot(threadId),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

function remainingPercent(usedPercent) {
  return Math.max(0, Math.min(100, 100 - Number(usedPercent || 0)));
}

function gaugeColor(usedPercent) {
  const p = Number(usedPercent || 0);
  if (p >= 90) return ansi.red;
  if (p >= 70) return ansi.yellow;
  if (p >= 40) return ansi.cyan;
  return ansi.green;
}

function gauge(remaining, width = 30) {
  const p = Math.max(0, Math.min(100, Number(remaining || 0)));
  const filled = Math.round((p / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

// Build a usage card with a header strip, big remaining %, a gauge, and a
// footer line showing resets-at + a countdown.
function buildCard(title, subtitle, usedPercent, resetsAt, opts = {}) {
  const width = opts.width || 40;
  const remaining = remainingPercent(usedPercent);
  const pctColor = gaugeColor(usedPercent);
  const gaugeWidth = width - 4;

  const top = color(`┌${"─".repeat(width - 2)}┐`, ansi.rule);
  const bottom = color(`└${"─".repeat(width - 2)}┘`, ansi.rule);

  const titleLine = ` ${color(title, ansi.bold + ansi.white)}${subtitle ? color("  " + subtitle, ansi.muted) : ""}`;
  const big = ` ${color(`${remaining.toFixed(0)}`, ansi.bold + pctColor)}${color("%", ansi.muted)} ${color("remaining", ansi.muted)}`;
  const usedLine = ` ${color("used ", ansi.muted)}${color(`${Number(usedPercent || 0).toFixed(1)}%`, ansi.white)}`;
  const gaugeLine = ` ${color(gauge(remaining, gaugeWidth), pctColor)}`;
  const resetIn = countdown(resetsAt);
  const resetLine = ` ${color("resets", ansi.muted)} ${color(formatDateTime(resetsAt), ansi.white)} ${color(`(in ${resetIn})`, ansi.muted)}`;

  const lines = [top];
  for (const body of [titleLine, big, usedLine, gaugeLine, resetLine]) {
    lines.push(color("│", ansi.rule) + padRight(body, width - 2) + color("│", ansi.rule));
  }
  lines.push(bottom);
  return lines;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function makeLayout(state) {
  const cols = Math.max(72, Math.min(120, process.stdout.columns || 80));
  const gap = 2;
  const cardWidth = Math.floor((cols - gap) / 2);

  // Cards: 5h and Weekly. Identical width, side by side.
  const fiveH = buildCard(
    "5-hour usage limit",
    state.rate ? null : color("no snapshot", ansi.yellow),
    state.rate?.rateLimits?.primary?.used_percent ?? 0,
    state.rate?.rateLimits?.primary?.resets_at ?? 0,
    { width: cardWidth }
  );
  const weekly = buildCard(
    "Weekly usage limit",
    null,
    state.rate?.rateLimits?.secondary?.used_percent ?? 0,
    state.rate?.rateLimits?.secondary?.resets_at ?? 0,
    { width: cardWidth }
  );

  const cardLines = [];
  const height = Math.max(fiveH.length, weekly.length);
  for (let i = 0; i < height; i += 1) {
    const l = padRight(fiveH[i] || "", cardWidth);
    const r = padRight(weekly[i] || "", cardWidth);
    cardLines.push(`${l}${" ".repeat(gap)}${r}`);
  }

  // Local usage panel.
  const localLines = [];
  localLines.push(color("Local usage", ansi.bold + ansi.white));
  localLines.push("");
  localLines.push(`  ${color("today", ansi.muted)}    ${color(fmt(state.totalToday).padStart(14), ansi.green)} ${color("tokens", ansi.muted)}`);
  localLines.push(`  ${color("all-time", ansi.muted)} ${color(fmt(state.totalAll).padStart(14), ansi.cyan)}  ${color("tokens", ansi.muted)}`);
  localLines.push(`  ${color("threads", ansi.muted)}  ${color(String(state.threadCount).padStart(14), ansi.white)}  ${color("active", ansi.muted)}`);

  // Recent threads table.
  const recentRows = state.recent.filter((row) => row.updatedAt > 0);
  const recentLines = [];
  recentLines.push(color("Recent threads", ansi.bold + ansi.white) + color("  ·  latest activity", ansi.muted));
  recentLines.push("");

  if (recentRows.length === 0) {
    recentLines.push(color("  no local threads yet", ansi.muted));
  } else {
    // Header row.
    const hTime = color("time", ansi.muted);
    const hTokens = color("tokens", ansi.muted);
    const hProvider = color("provider", ansi.muted);
    const hModel = color("model", ansi.muted);
    const hTitle = color("title", ansi.muted);
    recentLines.push(`  ${hTime.padEnd(10)} ${hTokens.padEnd(10)} ${hProvider.padEnd(8)} ${hModel.padEnd(14)} ${hTitle}`);
    recentLines.push(color("  " + "─".repeat(cols - 4), ansi.rule));

    for (const row of recentRows.slice(0, 5)) {
      const time = color(relativeTime(row.updatedAt).padEnd(10), ansi.grey);
      const total = row.totalTokens ?? row.tokensUsed;
      const tokens = color(fmtCompact(total).padStart(10), ansi.magenta);
      const provider = color(truncate((row.provider || row.source || "—").padEnd(8), 8), ansi.cyan);
      const model = color(truncate((row.model || "—").padEnd(14), 14), ansi.accentSoft);
      const title = row.title || "(untitled)";
      const maxTitle = cols - 4 - 10 - 11 - 8 - 14 - 1;
      const trimmedTitle = truncate(title, Math.max(20, maxTitle));
      const cached = row.cachedTokens
        ? " " + color(`(+${fmtCompact(row.cachedTokens)} cached)`, ansi.muted)
        : "";
      recentLines.push(`  ${time} ${tokens} ${provider} ${model} ${color(trimmedTitle, ansi.white)}${cached}`);
    }
  }

  return { cardLines, localLines, recentLines, cols };
}

// Compose the full frame as an array of pre-styled lines.
function composeFrame(state) {
  const { cardLines, localLines, recentLines, cols } = makeLayout(state);

  const lines = [];

  // Title bar.
  const appName = color("CODEX ANALYTICS", ansi.bold + ansi.accent);
  const subName = color(" usage monitor", ansi.muted);
  const namePart = appName + subName;
  const status = state.rate
    ? color("● live", ansi.green)
    : color("○ no rate snapshot", ansi.yellow);
  const statusWidth = visibleLen(status);
  const nameWidth = visibleLen(namePart);
  const spacer = " ".repeat(Math.max(2, cols - nameWidth - statusWidth));
  lines.push(`${namePart}${spacer}${status}`);
  const rule = color("─".repeat(cols), ansi.rule);
  lines.push(rule);
  lines.push("");

  // Cards.
  for (const line of cardLines) lines.push(truncate(line, cols));
  lines.push("");

  // Local usage.
  for (const line of localLines) lines.push(truncate(line, cols));
  lines.push("");

  // Recent threads.
  for (const line of recentLines) lines.push(truncate(line, cols));
  lines.push("");

  // Status bar / footer.
  const now = new Date();
  const timeStr = color(now.toLocaleTimeString(), ansi.muted);
  const left = color("limit snapshot ", ansi.muted) +
    color(state.rate?.file ? path.basename(state.rate.file) : "—", ansi.greyDim);
  const right = color(`refresh ${Math.round(REFRESH_MS / 1000)}s · `, ansi.muted) + timeStr;
  const leftWidth = visibleLen(left);
  const rightWidth = visibleLen(right);
  const footerSpacer = " ".repeat(Math.max(1, cols - leftWidth - rightWidth));
  lines.push(rule);
  lines.push(`${left}${footerSpacer}${right}`);

  return lines;
}

// ---------------------------------------------------------------------------
// Tracking-render diff engine
// ---------------------------------------------------------------------------

class Frame {
  constructor() {
    this.lines = [];
    this.cols = 0;
  }

  set(lines, cols) {
    this.lines = lines;
    this.cols = cols;
  }
}

function diffAndDraw(prev, next) {
  let out = "";
  const maxRows = Math.max(prev.lines.length, next.lines.length);
  for (let i = 0; i < maxRows; i += 1) {
    const prevLine = prev.lines[i] ?? "";
    const nextLine = next.lines[i] ?? "";
    if (prevLine === nextLine) continue;
    out += goto(i + 1, 1);
    out += ansi.clearLine;
    if (nextLine) out += nextLine;
    out += "\r\n";
  }
  // Clear any leftover lines below the new frame.
  for (let i = maxRows; i < prev.lines.length; i += 1) {
    out += goto(i + 1, 1) + ansi.clearLine + "\r\n";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function renderKey(state) {
  return JSON.stringify({
    error: state.error,
    totalToday: state.totalToday,
    totalAll: state.totalAll,
    threadCount: state.threadCount,
    threadId: state.threadId,
    rateTimestamp: state.rate?.timestamp,
    rateFile: state.rate?.file,
    rateLimits: state.rate?.rateLimits,
    recent: state.recent.map((row) => ({
      id: row.id,
      updatedAt: row.updatedAt,
      totalTokens: row.totalTokens,
      cachedTokens: row.cachedTokens,
      provider: row.provider,
      model: row.model,
      source: row.source,
      title: row.title,
    })),
  });
}

// Force a clock tick every second so relative-times in the recent panel stay
// live without re-querying the database.
function clockTickKey() {
  const now = new Date();
  return `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
}

let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  process.stdout.write(ansi.restore); // restore cursor
  process.stdout.write(ansi.show);
  process.stdout.write("\x1b[?1049l"); // leave alt screen
  process.stdout.write("\n");
  process.exit(0);
}

async function main() {
  let state = { updatedAt: null, totalToday: 0, totalAll: 0, threadCount: 0, recent: [], rate: null, error: null };
  let lastKey = "";
  let lastClockKey = "";
  const prevFrame = new Frame();
  const nextFrame = new Frame();

  const draw = () => {
    const cols = Math.max(72, Math.min(120, process.stdout.columns || 80));
    const lines = composeFrame(state);
    nextFrame.set(lines, cols);

    let out = diffAndDraw(prevFrame, nextFrame);
    if (out) process.stdout.write(out);
    prevFrame.set(lines, cols);
  };

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
    const key = renderKey(state) + clockTickKey();
    if (key !== lastKey) {
      lastKey = key;
      draw();
    }
  };

  // Light timer that just updates the clock-dependent fields (relative time,
  // footer time) without re-querying the database.
  const clockTick = () => {
    const k = clockTickKey();
    if (k !== lastClockKey) {
      lastClockKey = k;
      const composite = renderKey(state) + k;
      if (composite !== lastKey) {
        lastKey = composite;
        draw();
      }
    }
  };

  // Setup: enter alt screen, save cursor, hide cursor.
  process.stdout.write("\x1b[?1049h"); // alt screen
  process.stdout.write(ansi.save);
  process.stdout.write(ansi.hide);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    process.stdout.write(ansi.show);
    process.stdout.write("\x1b[?1049l"); // leave alt screen
  });

  // Initial draw.
  tick();
  lastClockKey = clockTickKey();

  // Database refresh every REFRESH_MS.
  setInterval(tick, REFRESH_MS);
  // Render clock updates every second.
  setInterval(clockTick, 1000);
}

main().catch((err) => {
  process.stdout.write(ansi.show);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
