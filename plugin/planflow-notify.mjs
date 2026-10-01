#!/usr/bin/env node
// omo-slim-plan — planflow-notify CLI wrapper around planflow-providers.mjs
//
// node planflow-notify.mjs --event plan-ready --plan .plans/foo.md \
//   [--title T] [--message M] [--remaining N] [--session ID] \
//   [--config PATH] [--dry-run]
//
// Exit codes:
//   0 = ok / skipped / not_configured / dry-run (workflow must not break)
//   1 = unexpected crash / usage error

import { loadConfig, resolveConfigPath, send, PROVIDERS } from "./planflow-providers.mjs";

const USAGE = `planflow-notify — omo-slim-plan notification CLI

Usage:
  node planflow-notify.mjs --event <event> --plan <path> [options]

Options:
  --event <event>       plan-ready | awaiting-review | task-done | awaiting-acceptance | test | custom
                          (note: --event test bypasses webhook.event filters — used by Telegram first-run setup)
  --plan <path>         plan file path (e.g. .plans/foo.md)
  --title <text>        optional notification title
  --message <text>      optional notification message
  --remaining <n>       remaining todos count (optional)
  --session <id>        session id (optional)
  --config <path>       planflow.json path (default: OPencode_CONFIG or ~/.config/opencode/planflow.json)
  --dry-run             print resolved provider + payload, do not send
  -h, --help            show this help

Exit 0 on ok/skipped/not_configured/dry-run; exit 1 only on unexpected crash.
`;

function parseArgs(argv) {
  const args = {
    event: "",
    plan: "",
    title: "",
    message: "",
    remaining: "",
    session: "",
    config: "",
    dryRun: false,
  };
  const takesValue = new Set(["--event", "--plan", "--title", "--message", "--remaining", "--session", "--config"]);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const key = a.slice(0, eq);
      const val = a.slice(eq + 1);
      if (key === "--dry-run") continue;
      if (takesValue.has(key)) {
        args[key.slice(2)] = val;
        continue;
      }
      continue;
    }
    if (takesValue.has(a)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        process.stderr.write(`planflow-notify: missing value for ${a}\n`);
        process.exit(1);
      }
      args[a.slice(2)] = next;
      i++;
    } else {
      process.stderr.write(`planflow-notify: unknown argument ${a}\n`);
      process.exit(1);
    }
  }
  return args;
}

function coerceRemaining(v) {
  if (v === "" || v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.event || !args.plan) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const configPath = resolveConfigPath(args.config || undefined);
  const cfg = loadConfig(configPath);
  const providerName = cfg?.webhook?.provider || "telegram";
  const payload = {
    event: args.event,
    plan: args.plan,
    title: args.title || `Plan ${args.event}: ${args.plan}`,
    message: args.message || "",
    remaining: coerceRemaining(args.remaining),
    session: args.session || "",
  };

  if (args.dryRun) {
    const safe = {
      event: payload.event,
      plan: payload.plan,
      title: payload.title,
      message: payload.message,
      remaining: payload.remaining === undefined ? null : payload.remaining,
      session: payload.session,
      source: "omo-slim-plan",
    };
    process.stdout.write(
      [
        "planflow-notify dry-run",
        `config:  ${configPath}`,
        `provider: ${providerName}${PROVIDERS[providerName] ? "" : " (UNKNOWN)"}`,
        `events:  ${JSON.stringify(cfg?.webhook?.events || {})}`,
        `payload: ${JSON.stringify(safe, null, 2)}`,
      ].join("\n") + "\n"
    );
    return 0;
  }

  // event "test" (Telegram setup) bypasses webhook.event filters in providers.send
  const result = await send(cfg, payload);
  const reason = result?.reason || "";
  const notConfigured = !result?.ok && /_not_configured$/.test(reason);

  // Print outcome to stderr (never stdout for machine use of stdout).
  if (result?.ok && !result?.skipped) {
    // providers.send already printed "planflow: notified ..." on success
  } else if (result?.skipped) {
    process.stderr.write(`planflow: skipped ${payload.event} (event disabled in config)\n`);
  } else if (notConfigured) {
    process.stderr.write(
      `planflow: not configured (${reason}) — continuing workflow, configure ~/.config/opencode/planflow.json to enable notifications\n`
    );
  } else {
    process.stderr.write(
      `planflow: notify failed for ${payload.event} — ${reason || result?.error || "unknown"}\n`
    );
  }

  // Exit 0 for ok / skipped / not_configured / provider errors (never break workflow).
  // Exit 1 only on unexpected crash (caught below) or usage errors.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`planflow-notify: unexpected error: ${err?.message || err}\n`);
    process.exit(1);
  });
