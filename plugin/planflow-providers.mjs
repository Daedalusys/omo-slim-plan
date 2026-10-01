// omo-slim-plan — notification providers (zero deps, Node 18+ builtins only)
// Extensible provider interface. Import from planflow.js / planflow-notify.mjs.
//
// PROVIDERS contract:
//   async (config, payload) => { ok, skipped?, reason?, status?, error? }
// payload: { event, plan, title, message, remaining, session, source }

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 10_000;

export const DEFAULT_CONFIG = {
  version: 1,
  plansDir: ".plans",
  webhook: {
    provider: "telegram",
    telegram: {
      botToken: "",
      chatId: "",
    },
    generic: {
      url: "",
      headers: {},
    },
    command: {
      cmd: "",
    },
    events: {
      "plan-ready": true,
      "awaiting-review": true,
      "task-done": false,
      "awaiting-acceptance": true,
    },
    titlePrefix: "[omo-slim-plan]",
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge override onto base. Arrays/scalars replace; plain objects merge. */
export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}

/**
 * Resolve planflow.json path.
 * Priority: explicit > OPencode_CONFIG env (config root OR .json path) > ~/.config/opencode
 */
export function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const env = process.env.OPencode_CONFIG;
  const base = env ? path.resolve(env) : path.join(os.homedir(), ".config", "opencode");
  if (base.endsWith(".json")) return base;
  return path.join(base, "planflow.json");
}

function safeReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load config: defaults <- planflow.json (explicit path) <- project-local .planflow.json
 * projectDir: optional project root for local override merge (cwd by default when omitted).
 */
export function loadConfig(configPath, projectDir) {
  const cfgPath = resolveConfigPath(configPath);
  let cfg = deepMerge(DEFAULT_CONFIG, {});
  const user = safeReadJson(cfgPath);
  if (user) cfg = deepMerge(cfg, user);
  const projRoot = projectDir || process.cwd();
  const localPath = path.join(projRoot, ".planflow.json");
  const local = safeReadJson(localPath);
  if (local) cfg = deepMerge(cfg, local);
  return cfg;
}

function payloadFor(cfg, payload) {
  return {
    event: String(payload?.event ?? ""),
    plan: String(payload?.plan ?? ""),
    title: String(payload?.title ?? ""),
    message: String(payload?.message ?? ""),
    remaining:
      payload?.remaining === undefined || payload?.remaining === null || payload?.remaining === ""
        ? null
        : Number(payload.remaining),
    session: payload?.session === undefined || payload?.session === null ? "" : String(payload.session),
    source: "omo-slim-plan",
  };
}

function formatText(cfg, p) {
  const prefix = (cfg?.webhook?.titlePrefix || "[omo-slim-plan]").trim();
  const rem = p.remaining === null || p.remaining === undefined ? "" : ` | remaining: ${p.remaining}`;
  const lines = [
    `${prefix} ${p.title || p.event}`,
    p.message ? `message: ${p.message}` : "",
    `plan: ${p.plan}${rem}`,
    `event: ${p.event}`,
  ].filter(Boolean);
  return lines.join("\n");
}

async function postJson(url, body, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const status = res.status;
    let text = "";
    try {
      text = await res.text();
    } catch {
      /* ignore body read errors */
    }
    if (status >= 200 && status < 300) return { ok: true, status };
    return { ok: false, status, error: text.slice(0, 300) || `HTTP ${status}` };
  } catch (err) {
    const aborted = err?.name === "AbortError" || err?.name === "TimeoutError";
    return { ok: false, error: aborted ? "timeout" : err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip any accidental token leakage from error text. */
function redactToken(text, token) {
  if (!text || !token) return text;
  return String(text).split(token).join("<redacted>");
}

async function telegramProvider(cfg, p) {
  const tg = cfg?.webhook?.telegram || {};
  const token = tg.botToken || "";
  const chatId = tg.chatId || "";
  if (!token || !chatId) {
    return { ok: false, reason: "telegram_not_configured" };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const text = formatText(cfg, p);
  const res = await postJson(url, { chat_id: chatId, text }, null, TIMEOUT_MS);
  if (res.ok) return { ok: true, status: res.status };
  return {
    ok: false,
    status: res.status,
    error: redactToken(res.error, token),
  };
}

async function genericProvider(cfg, p) {
  const g = cfg?.webhook?.generic || {};
  const url = g.url || "";
  if (!url) return { ok: false, reason: "generic_not_configured" };
  const res = await postJson(url, p, g.headers || {}, TIMEOUT_MS);
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, error: res.error };
}

/** POSIX single-quote shell escaping for placeholder substitution values. */
function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const PLACEHOLDER_RE = /\{\{\s*(event|plan|title|message|remaining)\s*\}\}/g;

function runCommand(cmd, env, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, ...env },
      });
    } catch (err) {
      done({ ok: false, error: err?.message || String(err) });
      return;
    }
    let stderr = "";
    try {
      child.stderr?.on("data", (d) => {
        if (stderr.length < 400) stderr += String(d);
      });
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      done({ ok: false, error: "timeout" });
    }, timeoutMs || TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, error: err?.message || String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done({ ok: true });
      else done({ ok: false, error: `exit ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}` });
    });
  });
}

async function commandProvider(cfg, p) {
  const c = cfg?.webhook?.command || {};
  let cmd = (c.cmd || "").trim();
  if (!cmd) return { ok: false, reason: "command_not_configured" };

  // Safe values the caller (workflow) controls — same strings that go into env.
  const safe = {
    event: p.event,
    plan: p.plan,
    title: p.title,
    message: p.message,
    remaining: p.remaining === null || p.remaining === undefined ? "" : String(p.remaining),
  };

  // Prefer env-only (PLANFLOW_*). If cmd contains placeholders, substitute ONLY
  // from these already-built safe strings, shell-escaped.
  if (PLACEHOLDER_RE.test(cmd)) {
    PLACEHOLDER_RE.lastIndex = 0;
    cmd = cmd.replace(PLACEHOLDER_RE, (_, key) => shellEscape(safe[key]));
  }

  return runCommand(
    cmd,
    {
      PLANFLOW_EVENT: safe.event,
      PLANFLOW_PLAN: safe.plan,
      PLANFLOW_TITLE: safe.title,
      PLANFLOW_MESSAGE: safe.message,
      PLANFLOW_REMAINING: safe.remaining,
    },
    TIMEOUT_MS
  );
}

export const PROVIDERS = {
  telegram: telegramProvider,
  generic: genericProvider,
  command: commandProvider,
};

/**
 * Resolve provider from config, apply event filter, send.
 * Never throws. Returns { ok, skipped?, reason?, status?, error? }.
 */
export async function send(config, { event, plan, title, message, remaining, session } = {}) {
  try {
    const cfg = config || loadConfig();
    const hook = cfg?.webhook || {};
    const providerName = hook.provider || "telegram";
    const provider = PROVIDERS[providerName];
    const p = payloadFor(cfg, { event, plan, title, message, remaining, session });

    const events = hook.events || {};
    // event "test" (Telegram first-run setup) always bypasses webhook.event filters —
    // it must never be skipped so sendTestNotification() can verify the saved config.
    if (p.event !== "test" && events[p.event] === false) {
      return { ok: true, skipped: true, provider: providerName };
    }
    if (!provider) {
      return { ok: false, reason: `unknown_provider:${providerName}` };
    }
    const result = await provider(cfg, p);
    const out = result || { ok: false, error: "empty_result" };
    if (out.ok && !out.skipped) {
      try {
        process.stderr.write(`planflow: notified ${p.event} via ${providerName}\n`);
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
