// omo-slim-plan — Telegram first-run setup helpers (zero deps, Node 18+ builtins only)
// Used by bin/install.js for interactive chat_id capture. Never logs the full bot token.
//
// Exports:
//   getMe(token) / getUpdates(token, offset) / sendMessage(token, chatId, text)
//   waitForMessage(token, { timeoutMs, pollIntervalMs, onStatus })
//   pickLatestMessage(resultArray)          — pure, testable
//   maskToken(token)                        — safe display form
//   promptConfirm(question) / promptLine(question) — readline/promises
//   saveChatIdToConfig(planflowPath, token, chatId)
//   runTelegramSetup({ token, planflowPath, log, warn }) — full interactive flow

import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const API_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_POLL_MS = 2_000;

function apiBase(token) {
  return `https://api.telegram.org/bot${token}`;
}

/** Safe display form — never the full token. */
export function maskToken(token) {
  const t = String(token || "");
  if (!t) return "(empty)";
  if (t.length <= 8) return "***";
  return `${t.slice(0, 6)}…${t.slice(-2)} (${t.length} chars)`;
}

/** Strip any accidental token leakage from error text. */
function redact(text, token) {
  if (!text || !token) return text;
  return String(text).split(token).join("<redacted>");
}

function describeTelegramError(json, token) {
  const desc = json?.description || "";
  const code = json?.error_code;
  const d = desc.toLowerCase();
  let hint = "";
  if (d.includes("unauthorized") || d.includes("not found") || d.includes("invalid")) {
    hint = "invalid bot token — re-copy it from @BotFather (/token)";
  } else if (d.includes("bot was blocked")) {
    hint = "bot was blocked by the user — unblock the bot in Telegram";
  } else if (d.includes("chat not found")) {
    hint = "chat not found — message the bot first, then retry";
  } else if (d.includes("bot can't initiate") || d.includes("bot can not initiate")) {
    hint = "bot cannot start the chat — open the bot and send /start";
  }
  const safe = redact(desc, token);
  return `telegram error ${code ?? ""}: ${safe}${hint ? ` (${hint})` : ""}`.replace(/\s+$/, "");
}

/**
 * Pure: pick the latest update entry that carries a chat.
 * Accepts the raw `result` array from getUpdates (message / channel_post / edited_*).
 */
export function pickLatestMessage(resultArray) {
  if (!Array.isArray(resultArray) || resultArray.length === 0) return null;
  let best = null;
  let bestId = -Infinity;
  for (const item of resultArray) {
    if (!item || typeof item !== "object") continue;
    const candidates = [item.message, item.channel_post, item.edited_message, item.edited_channel_post];
    for (const m of candidates) {
      if (!m || typeof m !== "object" || !m.chat) continue;
      const uid = Number.isFinite(item.update_id) ? item.update_id : 0;
      if (uid >= bestId) {
        bestId = uid;
        best = m;
      }
    }
  }
  return best;
}

async function telegramGet(token, method, params) {
  const url = new URL(`${apiBase(token)}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!json) return { ok: false, error: `HTTP ${res.status} (non-JSON response)`, token };
    if (json.ok === false) {
      return {
        ok: false,
        error: describeTelegramError(json, token),
        error_code: json.error_code,
        description: redact(json.description, token),
        token,
      };
    }
    return { ok: true, data: json.result, raw: json };
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
    return { ok: false, error: aborted ? "timeout" : e?.message || String(e), token };
  } finally {
    clearTimeout(timer);
  }
}

export async function getMe(token) {
  return telegramGet(token, "getMe");
}

export async function getUpdates(token, offset) {
  const params = { timeout: 0 };
  if (offset !== undefined && offset !== null && offset !== "") {
    params.offset = String(offset);
  }
  return telegramGet(token, "getUpdates", params);
}

export async function sendMessage(token, chatId, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase(token)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    if (json && json.ok === false) return { ok: false, error: describeTelegramError(json, token) };
    if (!json) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: json.result };
  } catch (e) {
    return {
      ok: false,
      error: e?.name === "AbortError" || e?.name === "TimeoutError" ? "timeout" : e?.message || String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll getUpdates until a message with a chat arrives.
 * onStatus({ elapsedMs, timeoutMs }) is called each poll (installer prints progress).
 * Supports Ctrl+C cleanly via process SIGINT handler set by runTelegramSetup.
 */
export async function waitForMessage(token, { timeoutMs = DEFAULT_WAIT_MS, pollIntervalMs = DEFAULT_POLL_MS, onStatus } = {}) {
  const started = Date.now();
  let offset; // undefined → read backlog first, then advance past seen updates
  let lastStatusLog = 0;
  const isTTY = Boolean(process.stdout.isTTY);

  while (true) {
    const elapsed = Date.now() - started;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      return { ok: false, reason: "timeout", elapsedMs: elapsed };
    }

    if (typeof onStatus === "function") {
      try {
        onStatus({ elapsedMs: elapsed, timeoutMs });
      } catch {
        /* ignore */
      }
    } else if (isTTY) {
      process.stdout.write(`\r  polling getUpdates… ${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s   `);
    } else if (elapsed - lastStatusLog >= 10_000) {
      lastStatusLog = elapsed;
      process.stdout.write(`polling getUpdates… ${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s\n`);
    }

    const res = await getUpdates(token, offset);
    if (!res.ok) {
      const errText = String(res.error || "");
      const hard = /unauthorized|not found|bot can't|invalid/i.test(errText);
      if (hard) {
        return { ok: false, reason: "api_error", error: errText, elapsedMs: Date.now() - started };
      }
      // transient network error → retry until timeout
    } else if (Array.isArray(res.data) && res.data.length > 0) {
      const msg = pickLatestMessage(res.data);
      const last = res.data[res.data.length - 1];
      if (last && Number.isFinite(last.update_id)) offset = last.update_id + 1;
      if (msg) {
        return { ok: true, message: msg, offset };
      }
      // updates without a chat (e.g. inline queries) — already advanced offset
    }

    await sleep(Math.max(200, Math.min(pollIntervalMs, remaining)));
  }
}

export function promptConfirm(question) {
  return promptLine(question);
}

export function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl
    .question(question)
    .then((ans) => {
      rl.close();
      return ans;
    })
    .catch((e) => {
      rl.close();
      throw e;
    });
}

function formatCaptured(msg) {
  const chat = msg?.chat || {};
  const from = msg?.from || {};
  const name = from.first_name
    ? [from.first_name, from.last_name].filter(Boolean).join(" ")
    : "";
  const handle = from.username ? ` (@${from.username})` : "";
  const text = msg?.text ?? msg?.caption ?? "";
  return [
    "捕获到消息:",
    `  chat_id   : ${chat.id ?? "(none)"}`,
    `  chat_type : ${chat.type ?? "(unknown)"}`,
    `  from      : ${name || "(unknown)"}${handle}`,
    `  text      : ${text === "" ? "(empty)" : text}`,
  ].join("\n");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Persist botToken + chatId into planflow.json (creates shape if missing). */
export function saveChatIdToConfig(planflowPath, token, chatId) {
  const cfg = readJsonSafe(planflowPath) || {};
  if (!cfg.webhook || typeof cfg.webhook !== "object") cfg.webhook = {};
  if (!cfg.webhook.telegram || typeof cfg.webhook.telegram !== "object") cfg.webhook.telegram = {};
  if (token) cfg.webhook.telegram.botToken = token;
  cfg.webhook.telegram.chatId = String(chatId);
  cfg.webhook.provider = "telegram";
  if (cfg.version === undefined) cfg.version = 1;
  if (cfg.plansDir === undefined) cfg.plansDir = ".plans";
  mkdirSync(path.dirname(planflowPath), { recursive: true });
  writeFileSync(planflowPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return cfg;
}

/**
 * Send a test notification through the normal provider path (event "test").
 * Lives here so installer and notify CLI share one implementation; providers.mjs
 * special-cases event==="test" to bypass event filters.
 */
export async function sendTestNotification(planflowPath, { log = console.log, warn = console.warn } = {}) {
  try {
    // This module sits next to planflow-providers.mjs after install and in the package.
    const providers = await import("./planflow-providers.mjs");
    const cfg = providers.loadConfig(planflowPath, process.cwd());
    const result = await providers.send(cfg, {
      event: "test",
      plan: "setup",
      title: "omo-slim-plan",
      message: "Telegram 配置成功",
    });
    if (result?.ok) {
      log("Test notification sent ✓ — check your Telegram.");
      return { ok: true, result };
    }
    if (result?.skipped) {
      warn("test event was skipped (unexpected) — check webhook.events in planflow.json");
      return { ok: false, result };
    }
    warn(`test notification failed: ${result?.reason || result?.error || "unknown"}`);
    return { ok: false, result };
  } catch (e) {
    warn(`test notification error: ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Full interactive Telegram first-run setup.
 * Returns { saved, chatId, token, tested }.
 */
export async function runTelegramSetup({
  token,
  planflowPath,
  log = console.log,
  warn = console.warn,
} = {}) {
  log("");
  log("=== Telegram first-run setup ===");

  // Ctrl+C → clean exit, no stack trace
  const onSigint = () => {
    process.stdout.write("\n");
    log("Cancelled. Re-run setup anytime: npx omo-slim-plan --setup-telegram");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    // 1. Token: flag/config value, or prompt
    let tok = String(token || "").trim();
    if (!tok) {
      const ans = (await promptLine("Bot token from @BotFather (stored only in planflow.json): ")).trim();
      tok = ans;
    }
    if (!tok) {
      log("No token provided — skipping Telegram setup.");
      log("Re-run: npx omo-slim-plan --setup-telegram   (or pass --telegram-token)");
      return { saved: false, chatId: null, token: null, tested: false };
    }
    log(`  token: ${maskToken(tok)}`);

    // 2. getMe → bot identity + open hint
    const me = await getMe(tok);
    if (!me.ok) {
      log(`getMe failed: ${me.error}`);
      log("Check the token (@BotFather → /token) and that the bot is not blocked.");
      return { saved: false, chatId: null, token: tok, tested: false };
    }
    const username = me.data?.username ? `@${me.data.username}` : "(no username)";
    log(`  bot: ${username}${me.data?.first_name ? ` (${me.data.first_name})` : ""}`);
    log("");
    log("Please message this bot in Telegram now (any text, e.g. /start or hi).");
    log("Waiting for your message… (timeout 120s, Ctrl+C to cancel)");

    // 3. Poll getUpdates with status
    const waitRes = await waitForMessage(tok, {
      timeoutMs: DEFAULT_WAIT_MS,
      pollIntervalMs: DEFAULT_POLL_MS,
      onStatus: ({ elapsedMs }) => {
        const total = Math.round(DEFAULT_WAIT_MS / 1000);
        const cur = Math.round(elapsedMs / 1000);
        if (process.stdout.isTTY) {
          process.stdout.write(`\r  polling getUpdates… ${cur}s / ${total}s   `);
        } else if (elapsedMs % 10_000 < DEFAULT_POLL_MS) {
          process.stdout.write(`polling getUpdates… ${cur}s / ${total}s\n`);
        }
      },
    });
    if (process.stdout.isTTY) process.stdout.write("\n");

    if (!waitRes.ok) {
      if (waitRes.reason === "timeout") {
        log("Timed out waiting for a message. Make sure you actually messaged the bot, then retry:");
        log("  npx omo-slim-plan --setup-telegram");
      } else {
        log(`getUpdates failed: ${waitRes.error}`);
      }
      return { saved: false, chatId: null, token: tok, tested: false };
    }

    const msg = waitRes.message;
    const chatId = msg?.chat?.id;

    // 4. Confirm capture
    log("");
    log(formatCaptured(msg));
    log("");
    const ans = (await promptConfirm("是否将此 chat_id 保存到 planflow.json? [Y/n] "))
      .trim()
      .toLowerCase();
    if (ans === "n" || ans === "no") {
      log("Discarded — chatId left empty. Re-run setup when ready.");
      return { saved: false, chatId: null, token: tok, tested: false };
    }

    // 5. Save + optionally acknowledge updates with offset
    saveChatIdToConfig(planflowPath, tok, String(chatId));
    log(`Saved chatId ${chatId} → ${planflowPath}`);
    if (waitRes.offset !== undefined && waitRes.offset !== null) {
      // Best-effort acknowledge so the captured message is not re-offered later
      try {
        await getUpdates(tok, waitRes.offset);
      } catch {
        /* ignore */
      }
    }

    // 6. Test notification through providers (event "test" bypasses filters)
    const test = await sendTestNotification(planflowPath, { log, warn });
    return { saved: true, chatId: String(chatId), token: tok, tested: Boolean(test?.ok) };
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
