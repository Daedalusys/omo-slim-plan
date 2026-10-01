#!/usr/bin/env node
// omo-slim-plan installer — zero deps, Node 18+ builtins only.
//
// Usage:
//   node bin/install.js [--dry-run] [--force] [--uninstall]
//                       [--webhook <url>] [--telegram-token <t>] [--telegram-chat-id <id>]
//                       [--setup-telegram] [--config <path>]
//
// Telegram first-run: pass --telegram-token (or --setup-telegram). After files
// are installed, the installer can capture chat_id interactively (message the
// bot → getUpdates → confirm) so users never need to look up chat_id manually.
//
// Defaults:
//   Config root : $OPencode_CONFIG  ||  ~/.config/opencode
//   Skill root  : ~/.config/skillshare/skills  (if directory)  else  <configRoot>/skills
//   Commands    : <configRoot>/command/
//   Plugins     : <configRoot>/plugin/
//   Config file : <configRoot>/planflow.json
//   Plans       : .plans/ per project (documented, not installed here)

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMMAND_FILES = ["plan.md", "start-work.md", "plan-review.md"];
const PLUGIN_FILES = [
  "planflow.js",
  "planflow-notify.mjs",
  "planflow-providers.mjs",
  "planflow-telegram.mjs",
];
const DEFAULT_PLANFLOW = {
  version: 1,
  plansDir: ".plans",
  webhook: {
    provider: "telegram",
    telegram: { botToken: "", chatId: "" },
    generic: { url: "", headers: {} },
    command: { cmd: "" },
    events: {
      "plan-ready": true,
      "awaiting-review": true,
      "task-done": false,
      "awaiting-acceptance": true,
    },
    titlePrefix: "[omo-slim-plan]",
  },
};

const useColor = process.stdout.isTTY || process.env.FORCE_COLOR;
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const cyan = (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(msg) {
  process.stdout.write(msg + "\n");
}
function warn(msg) {
  process.stderr.write(cyan("warn: ") + msg + "\n");
}
function err(msg) {
  process.stderr.write(red("error: ") + msg + "\n");
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    force: false,
    uninstall: false,
    webhook: "",
    telegramToken: "",
    telegramChatId: "",
    setupTelegram: false,
    config: "",
    help: false,
  };
  const takesValue = new Set([
    "--webhook",
    "--telegram-token",
    "--telegram-chat-id",
    "--config",
  ]);
  const keyMap = {
    "--webhook": "webhook",
    "--telegram-token": "telegramToken",
    "--telegram-chat-id": "telegramChatId",
    "--config": "config",
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--force") {
      args.force = true;
      continue;
    }
    if (a === "--uninstall") {
      args.uninstall = true;
      continue;
    }
    if (a === "--setup-telegram") {
      args.setupTelegram = true;
      continue;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const key = a.slice(0, eq);
      const val = a.slice(eq + 1);
      if (takesValue.has(key)) {
        args[keyMap[key]] = val;
        continue;
      }
      continue;
    }
    if (takesValue.has(a)) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next !== "-")) {
        throw new Error(`missing value for ${a}`);
      }
      args[keyMap[a]] = next;
      i++;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  process.stdout.write(
    [
      "omo-slim-plan installer",
      "",
      "Usage:",
      "  node bin/install.js [options]",
      "",
      "Options:",
      "  --dry-run                 Print planned actions; write nothing; exit 0",
      "  --force                   Overwrite existing planflow.json / remove it on --uninstall",
      "  --uninstall               Remove installed files; unregister plugin; keep planflow.json unless --force",
      "  --webhook <url>           generic webhook provider (sets provider=generic, generic.url=<url>)",
      "  --telegram-token <t>      Telegram bot token (sets provider=telegram)",
      "  --telegram-chat-id <id>   Telegram chat id (optional; omit to capture interactively)",
      "  --setup-telegram          Interactive Telegram setup: message the bot, confirm chat_id",
      "  --config <path>           OpenCode config root (dir) or planflow.json path",
      "  -h, --help                Show help",
      "",
    ].join("\n")
  );
}

/** Refuse to write outside config root + skillshare root. */
function assertInside(target, roots) {
  const t = path.resolve(target);
  const allowed = roots.filter(Boolean).map((r) => path.resolve(r));
  const bad = !allowed.some((root) => t === root || t.startsWith(root + path.sep));
  if (bad) {
    throw new Error(`refusing to write outside allowed roots: ${t}`);
  }
}

function backupFile(target) {
  if (!existsSync(target)) return null;
  const bak = `${target}.bak-${ts()}`;
  copyFileSync(target, bak);
  return bak;
}

function resolvePaths(args) {
  const home = os.homedir();
  // Config root: --config (dir or json) > OPencode_CONFIG env > ~/.config/opencode
  let configRoot;
  let planflowPath;
  const explicit = args.config || process.env.OPencode_CONFIG || "";
  if (explicit) {
    const p = path.resolve(explicit);
    if (p.endsWith(".json")) {
      planflowPath = p;
      configRoot = path.dirname(p);
    } else {
      configRoot = p;
      planflowPath = path.join(configRoot, "planflow.json");
    }
  } else {
    configRoot = path.join(home, ".config", "opencode");
    planflowPath = path.join(configRoot, "planflow.json");
  }

  // Skill root: skillshare if present, else configRoot/skills
  const skillshare = path.join(home, ".config", "skillshare", "skills");
  let skillRoot = null;
  try {
    if (existsSync(skillshare) && statSync(skillshare).isDirectory()) skillRoot = skillshare;
  } catch {
    skillRoot = null;
  }
  const skillDest = skillRoot
    ? path.join(skillRoot, "plan-workflow", "SKILL.md")
    : path.join(configRoot, "skills", "plan-workflow", "SKILL.md");

  const commandDir = path.join(configRoot, "command");
  const pluginDir = path.join(configRoot, "plugin");
  const opencodeJson = path.join(configRoot, "opencode.json");

  return {
    configRoot,
    planflowPath,
    skillDest,
    skillRoot,
    commandDir,
    pluginDir,
    opencodeJson,
    allowedRoots: [configRoot, skillRoot].filter(Boolean),
  };
}

/** Trivial JSONC tolerance: strip comments + trailing commas. */
function tryParseJsonc(raw) {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

function readOpencodeJson(file) {
  const raw = readFileSync(file, "utf8");
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e1) {
    try {
      return { ok: true, data: tryParseJsonc(raw), jsonc: true };
    } catch (e2) {
      return { ok: false, error: e1?.message || String(e1) };
    }
  }
}

function ensurePluginArray(data, mode) {
  // mode: "add" | "remove"
  let arr = data.plugin;
  if (arr === undefined) {
    if (mode === "remove") return { changed: false, arr: undefined };
    data.plugin = ["planflow"];
    return { changed: true, arr: data.plugin };
  }
  if (typeof arr === "string") arr = [arr];
  if (!Array.isArray(arr)) {
    return { changed: false, arr, invalid: true };
  }
  const has = arr.includes("planflow");
  if (mode === "add" && !has) {
    arr.push("planflow");
    return { changed: true, arr };
  }
  if (mode === "remove" && has) {
    data.plugin = arr.filter((x) => x !== "planflow");
    return { changed: true, arr: data.plugin };
  }
  return { changed: false, arr: data.plugin };
}

function writeOpencodeJson(file, data, dryRun) {
  const out = JSON.stringify(data, null, 2) + "\n";
  if (dryRun) {
    log(`  [dry-run] would write ${file} (plugin array ${JSON.stringify(data.plugin || [])})`);
    return;
  }
  const bak = backupFile(file);
  if (bak) log(`  backup: ${bak}`);
  writeFileSync(file, out, "utf8");
  log(`  wrote: ${file}`);
}

function buildPlanflowConfig(args, existing) {
  const base = existing ? { ...existing } : JSON.parse(JSON.stringify(DEFAULT_PLANFLOW));
  // Ensure webhook shape exists
  if (!base.webhook || typeof base.webhook !== "object") {
    base.webhook = JSON.parse(JSON.stringify(DEFAULT_PLANFLOW.webhook));
  }
  base.webhook = { ...JSON.parse(JSON.stringify(DEFAULT_PLANFLOW.webhook)), ...base.webhook };
  if (args.webhook) {
    base.webhook.provider = "generic";
    base.webhook.generic = { ...(base.webhook.generic || {}), url: args.webhook };
  }
  if (args.telegramToken || args.telegramChatId) {
    base.webhook.provider = "telegram";
    base.webhook.telegram = {
      ...(base.webhook.telegram || {}),
      ...(args.telegramToken ? { botToken: args.telegramToken } : {}),
      ...(args.telegramChatId ? { chatId: args.telegramChatId } : {}),
    };
  }
  if (base.version === undefined) base.version = 1;
  if (base.plansDir === undefined) base.plansDir = ".plans";
  return base;
}

function copyTemplate(src, dest, roots, dryRun, label) {
  if (!existsSync(src)) {
    warn(`template missing: ${src}`);
    return { skipped: true, reason: "template_missing" };
  }
  assertInside(dest, roots);
  const exists = existsSync(dest);
  if (dryRun) {
    log(`  [dry-run] ${exists ? "backup+overwrite" : "copy"} ${src} -> ${dest}`);
    return { ok: true, dryRun: true };
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  if (exists) {
    const bak = backupFile(dest);
    log(`  backup: ${bak}`);
  }
  copyFileSync(src, dest);
  log(`  ${exists ? "updated" : "installed"}: ${dest}${label ? ` (${label})` : ""}`);
  return { ok: true };
}

function removeIfExists(target, dryRun, roots, label) {
  if (!existsSync(target)) {
    log(`  (absent) ${target}`);
    return { removed: false };
  }
  assertInside(target, roots);
  if (dryRun) {
    log(`  [dry-run] would remove ${target}${label ? ` (${label})` : ""}`);
    return { removed: false, dryRun: true };
  }
  rmSync(target, { recursive: true, force: true });
  log(`  removed: ${target}${label ? ` (${label})` : ""}`);
  return { removed: true };
}

function readPlanflowJsonSafe(planflowPath) {
  try {
    return JSON.parse(readFileSync(planflowPath, "utf8"));
  } catch {
    return null;
  }
}

function printNextSteps(p, setupState) {
  log("");
  log(bold("Next steps:"));
  log("  1. Restart OpenCode so it loads the planflow plugin.");
  log(`  2. Configure Telegram (or generic/command) in ${p.planflowPath}`);
  log("     - telegram: npx omo-slim-plan --setup-telegram   (message the bot; chat_id is captured)");
  log("     - generic:  set webhook.provider=generic + webhook.generic.url");
  log("     - command:  set webhook.provider=command + webhook.command.cmd");
  log("  3. In a project, run /plan — AI writes .plans/<slug>.md, then you choose:");
  log("     start-work <slug> | plan-review <slug> | revise plan");
  log("");
  log(`  Commands installed: ${p.commandDir}/plan.md, start-work.md, plan-review.md`);
  log(`  Skill installed:    ${p.skillDest}`);
  log(`  Plugin installed:   ${p.pluginDir}/planflow.js (+ planflow-notify.mjs, planflow-providers.mjs, planflow-telegram.mjs)`);
  log(`  Notify CLI:         ${p.pluginDir}/planflow-notify.mjs`);
  log(`  Plans convention:   .plans/ per project (see templates/plans/README.md; commit plans, not boulder)`);
  if (setupState) {
    if (setupState.saved) {
      log("");
      log(green(`  Telegram chat_id saved: ${setupState.chatId}`));
    } else if (setupState.needed) {
      log("");
      warn("  Telegram chat_id is empty — run setup to capture it:");
      log("    npx omo-slim-plan --setup-telegram");
      log("    # or: node bin/install.js --setup-telegram");
    }
  }
}

/**
 * Decide whether interactive Telegram setup should run after install.
 * Returns { needed, reason }.
 */
function evaluateTelegramSetup(args, cfg) {
  if (args.uninstall) return { needed: false, reason: "skipped" };
  if (args.setupTelegram) return { needed: true, reason: "flag" };
  if (args.telegramChatId) return { needed: false, reason: "chat_id_already_set" };
  const tg = cfg?.webhook?.telegram || {};
  const provider = cfg?.webhook?.provider || "telegram";
  const hasToken = Boolean(String(args.telegramToken || tg.botToken || "").trim());
  const hasChat = Boolean(String(tg.chatId || "").trim());
  if (provider === "telegram" && hasToken && !hasChat) {
    return { needed: true, reason: "token_without_chat_id" };
  }
  return { needed: false, reason: hasChat ? "chat_id_already_set" : "telegram_not_requested" };
}

function shouldRunTelegramSetup(args, p, cfg) {
  if (args.dryRun) return { needed: false, reason: "dry_run" };
  return evaluateTelegramSetup(args, cfg);
}

async function runInteractiveTelegramSetup(args, p, plan) {
  const { runTelegramSetup } = await import(
    pathToFileURL(path.join(PKG_ROOT, "plugin", "planflow-telegram.mjs")).href
  );
  const cfg = readPlanflowJsonSafe(p.planflowPath) || {};
  const token = String(args.telegramToken || cfg?.webhook?.telegram?.botToken || "").trim();
  log("");
  log(bold("Telegram setup:"));
  if (!process.stdin.isTTY && !token) {
    warn("stdin is not a TTY and no --telegram-token was provided — skipping interactive setup");
    log("  re-run: npx omo-slim-plan --setup-telegram --telegram-token <token>");
    return { needed: true, saved: false, chatId: null, tested: false };
  }
  const result = await runTelegramSetup({
    token,
    planflowPath: p.planflowPath,
    log,
    warn,
  });
  return { needed: true, saved: Boolean(result?.saved), chatId: result?.chatId ?? null, tested: Boolean(result?.tested) };
}

async function runInstall(args, p) {
  log(bold("omo-slim-plan installer"));
  log(cyan("Resolving paths..."));
  log(`  config root : ${p.configRoot}`);
  log(`  planflow.json: ${p.planflowPath}`);
  log(`  commands    : ${p.commandDir}/`);
  log(`  plugins     : ${p.pluginDir}/`);
  log(`  skill dest  : ${p.skillDest}`);
  if (p.skillRoot) log(`  skill root  : ${p.skillRoot} (skillshare)`);
  log(`  opencode.json: ${p.opencodeJson}`);
  log("");

  if (args.dryRun) log(bold("Dry-run — no files will be written."));
  log(bold(args.uninstall ? "Uninstall actions:" : "Install actions:"));

  // --- 1/2/5/6: commands + skill + plugin files ---
  if (!args.uninstall) {
    log(cyan("Commands:"));
    for (const name of COMMAND_FILES) {
      copyTemplate(
        path.join(PKG_ROOT, "templates", "command", name),
        path.join(p.commandDir, name),
        p.allowedRoots,
        args.dryRun
      );
    }
    log(cyan("Skill:"));
    copyTemplate(
      path.join(PKG_ROOT, "templates", "skills", "plan-workflow", "SKILL.md"),
      p.skillDest,
      p.allowedRoots,
      args.dryRun,
      "plan-workflow"
    );
    log(cyan("Plugin:"));
    for (const name of PLUGIN_FILES) {
      copyTemplate(
        path.join(PKG_ROOT, "plugin", name),
        path.join(p.pluginDir, name),
        p.allowedRoots,
        args.dryRun
      );
    }
    log(cyan("Plans template (reference only):"));
    log(`  [ref] templates/plans/README.md — copy into projects as .plans/README.md if desired`);

    // --- 7: planflow.json ---
    log(cyan("Config:"));
    const exists = existsSync(p.planflowPath);
    if (exists && !args.force) {
      if (args.dryRun) {
        log(`  [dry-run] ${p.planflowPath} exists — leave untouched (use --force to overwrite)`);
      } else {
        log(`  kept existing: ${p.planflowPath} (use --force to overwrite with CLI flags)`);
      }
    } else if (exists && args.force) {
      let existing = null;
      try {
        existing = JSON.parse(readFileSync(p.planflowPath, "utf8"));
      } catch (parseErr) {
        warn(`existing planflow.json is not valid JSON (${parseErr?.message || parseErr}) — rebuilding from defaults + CLI flags`);
      }
      const cfg = buildPlanflowConfig(args, existing);
      if (args.dryRun) {
        log(`  [dry-run] would backup+overwrite ${p.planflowPath} (force)`);
      } else {
        const bak = backupFile(p.planflowPath);
        if (bak) log(`  backup: ${bak}`);
        mkdirSync(path.dirname(p.planflowPath), { recursive: true });
        writeFileSync(p.planflowPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
        log(`  wrote: ${p.planflowPath} (force overwrite)`);
      }
    } else {
      const cfg = buildPlanflowConfig(args, null);
      if (args.dryRun) {
        log(`  [dry-run] would write default planflow.json -> ${p.planflowPath}`);
      } else {
        mkdirSync(path.dirname(p.planflowPath), { recursive: true });
        writeFileSync(p.planflowPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
        log(`  wrote: ${p.planflowPath}`);
      }
    }

    // --- 8: opencode.json plugin registration ---
    log(cyan("opencode.json:"));
    mergePluginRegistration(p, "add", args.dryRun);
  } else {
    // --- 9: uninstall ---
    log(cyan("Commands:"));
    for (const name of COMMAND_FILES) {
      removeIfExists(path.join(p.commandDir, name), args.dryRun, p.allowedRoots);
    }
    log(cyan("Skill:"));
    const skillDir = path.dirname(p.skillDest);
    removeIfExists(skillDir, args.dryRun, p.allowedRoots, "plan-workflow skill");
    log(cyan("Plugin:"));
    for (const name of PLUGIN_FILES) {
      removeIfExists(path.join(p.pluginDir, name), args.dryRun, p.allowedRoots);
    }
    log(cyan("opencode.json:"));
    mergePluginRegistration(p, "remove", args.dryRun);
    log(cyan("Config:"));
    if (args.force) {
      removeIfExists(p.planflowPath, args.dryRun, p.allowedRoots, "planflow.json (--force)");
    } else if (existsSync(p.planflowPath)) {
      log(`  kept: ${p.planflowPath} (use --force to delete)`);
    } else {
      log(`  (absent) ${p.planflowPath}`);
    }
    log("");
    log(bold("What remains after uninstall:"));
    log(`  - ${p.planflowPath} (unless --force) — user webhook tokens/config`);
    log(`  - ${p.opencodeJson} — other plugins (oh-my-opencode-slim etc.) preserved`);
    log(`  - project .plans/ directories — not touched by the installer`);
  }

  if (args.dryRun) {
    const dryCfg = readPlanflowJsonSafe(p.planflowPath) || buildPlanflowConfig(args, null);
    const setupPreview = evaluateTelegramSetup(args, dryCfg);
    log("");
    log(cyan("Telegram setup:"));
    if (setupPreview.needed) {
      log(`  [dry-run] would run interactive setup (${setupPreview.reason}) — message the bot, confirm chat_id`);
      log(`  (interactive prompts require a TTY; not executed in dry-run)`);
    } else {
      log(`  skipped (${setupPreview.reason})`);
    }
    log(green("Dry-run complete — nothing was written."));
    return 0;
  }
  if (args.uninstall) {
    log("");
    log(green("Uninstall complete. Restart OpenCode to drop the plugin."));
    return 0;
  }

  // --- 10: optional interactive Telegram first-run setup ---
  const cfgNow = readPlanflowJsonSafe(p.planflowPath) || {};
  const setupPlan = shouldRunTelegramSetup(args, p, cfgNow);
  let setupState = null;
  if (setupPlan.needed) {
    log(cyan("Telegram setup:"));
    log(`  reason: ${setupPlan.reason}`);
    setupState = await runInteractiveTelegramSetup(args, p, setupPlan);
  } else {
    log(cyan("Telegram setup:"));
    log(`  skipped (${setupPlan.reason})`);
    const tg = cfgNow?.webhook?.telegram || {};
    const provider = cfgNow?.webhook?.provider || "telegram";
    if (provider === "telegram" && !String(tg.chatId || "").trim()) {
      setupState = { needed: true, saved: false, chatId: null, tested: false };
    }
  }

  printNextSteps(p, setupState);
  return 0;
}

function mergePluginRegistration(p, mode, dryRun) {
  if (!existsSync(p.opencodeJson)) {
    if (mode === "add") {
      const data = { plugin: ["planflow"] };
      if (dryRun) {
        log(`  [dry-run] would create ${p.opencodeJson} with plugin: ["planflow"]`);
      } else {
        mkdirSync(path.dirname(p.opencodeJson), { recursive: true });
        writeFileSync(p.opencodeJson, JSON.stringify(data, null, 2) + "\n", "utf8");
        log(`  created: ${p.opencodeJson} (plugin: ["planflow"])`);
      }
    } else {
      log(`  (absent) ${p.opencodeJson}`);
    }
    return;
  }
  const parsed = readOpencodeJson(p.opencodeJson);
  if (!parsed.ok) {
    warn(`could not parse ${p.opencodeJson}: ${parsed.error}`);
    warn("skipping plugin registration merge. Fix the JSON manually:");
    warn(`  - add "planflow" to the "plugin" array, or remove it`);
    warn(`  - example: "plugin": ["oh-my-opencode-slim", "planflow"]`);
    warn(`  - after editing, restart OpenCode`);
    return;
  }
  if (parsed.jsonc) {
    warn(`${p.opencodeJson} contained JSONC — parsed via tolerant strip; output will be normalized JSON`);
  }
  const data = parsed.data;
  const { changed, invalid } = ensurePluginArray(data, mode);
  if (invalid) {
    warn(`opencode.json has a non-array "plugin" key — skipping merge`);
    warn(`  set "plugin": ["planflow", ...] manually in ${p.opencodeJson}`);
    return;
  }
  if (!changed) {
    log(`  no change needed (plugin already ${mode === "add" ? "registered" : "absent"}): ${p.opencodeJson}`);
    return;
  }
  writeOpencodeJson(p.opencodeJson, data, dryRun);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    err(e?.message || String(e));
    usage();
    process.exit(1);
    return;
  }
  if (args.help) {
    usage();
    process.exit(0);
    return;
  }
  try {
    const p = resolvePaths(args);
    runInstall(args, p)
      .then((code) => {
        process.exit(code);
      })
      .catch((e) => {
        err(e?.message || String(e));
        process.exit(1);
      });
  } catch (e) {
    err(e?.message || String(e));
    process.exit(1);
  }
}

main();
