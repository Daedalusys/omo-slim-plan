// omo-slim-plan — OpenCode plugin
// Conservative planflow plugin: observes .plans/*.md status transitions and
// sends webhook notifications via ./planflow-providers.mjs.
// NEVER edits product code; NEVER fetches anything except through providers.
//
// Plugin API assumptions (best-effort, defensive):
// - Factory receives { directory, project, worktree, client, $ }
// - Returns a hooks object; hook names observed in this environment:
//     "chat.headers": async (input, output) => {}
//     event: async ({ event }) => {}   // event.type e.g. "session.updated"
// - Unknown event payloads are tolerated; every hook body try/catches.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveConfigPath, send } from "./planflow-providers.mjs";

const NOTIFY_MIN_INTERVAL_MS = 60_000;

function isPlanPath(p) {
  return typeof p === "string" && p.includes(".plans/") && p.endsWith(".md");
}

function joinPlanPath(dir, p) {
  return path.isAbsolute(p) ? p : path.join(dir, p);
}

/** Read plan metadata + open checkbox count. Returns null on any failure. */
async function readPlanMeta(absPath) {
  try {
    const raw = await readFile(absPath, "utf8");
    const statusMatch = raw.match(/^\s*-\s*status:\s*(\S+)\s*$/m);
    const status = statusMatch ? statusMatch[1] : "";
    const openBoxes = (raw.match(/^\s*-\s*\[\s\]\s+/gm) || []).length;
    return { status, openBoxes, raw };
  } catch {
    return null;
  }
}

/** Collect candidate file-path strings from an unknown event shape (bounded depth). */
function collectPaths(node, out, depth) {
  if (!node || typeof node !== "object" || depth > 4 || out.length >= 8) return out;
  for (const [k, v] of Object.entries(node)) {
    if (out.length >= 8) break;
    if (typeof v === "string") {
      const key = k.toLowerCase();
      if (
        key === "path" ||
        key === "filepath" ||
        key === "file_path" ||
        key === "filename" ||
        key === "file" ||
        key === "file_path"
      ) {
        out.push(v);
      } else if (v.includes(".plans/") && v.endsWith(".md")) {
        out.push(v);
      }
    } else if (v && typeof v === "object") {
      collectPaths(v, out, depth + 1);
    }
  }
  return out;
}

function toolNameOf(event) {
  const props = event?.properties || event?.data || event?.payload || {};
  const cands = [event?.tool, event?.name, props?.tool, props?.name, props?.toolName];
  for (const c of cands) if (typeof c === "string" && c) return c.toLowerCase();
  return "";
}

function eventLooksLikeFileWrite(type, tool) {
  const t = String(type || "").toLowerCase();
  if (t.includes("tool") || t.includes("edit") || t.includes("write") || t.includes("patch")) return true;
  return tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch";
}

function eventLooksLikeIdle(type) {
  const t = String(type || "").toLowerCase();
  return (
    t === "session.idle" ||
    t === "idle" ||
    t.includes("idle") ||
    t === "message.updated" ||
    t === "message.completed" ||
    t === "session.updated" ||
    t === "session.completed"
  );
}

export const PlanflowPlugin = async ({ directory, project, worktree, client, $ }) => {
  // Resolve project root; "/" is not a useful scan root.
  const rawDir = directory || worktree || project?.worktree || process.cwd();
  const dir = rawDir && rawDir !== "/" ? path.resolve(rawDir) : null;

  /** plan abs path -> last notify timestamp */
  const debounced = new Map();

  async function notifyPlan(relPath, event, title, message, remaining) {
    if (!dir) return;
    const abs = joinPlanPath(dir, relPath);
    const now = Date.now();
    const last = debounced.get(abs) || 0;
    if (now - last < NOTIFY_MIN_INTERVAL_MS) return;
    debounced.set(abs, now);
    try {
      const cfg = loadConfig(resolveConfigPath(undefined), dir);
      await send(cfg, {
        event,
        plan: relPath,
        title,
        message,
        remaining,
        session: "",
      });
    } catch {
      // Notification must never break the host tool call.
    }
  }

  async function handlePlanFile(absPath, relPath) {
    const meta = await readPlanMeta(absPath);
    if (!meta) return;
    const name = path.basename(absPath);
    if (meta.status === "ready") {
      await notifyPlan(
        relPath,
        "plan-ready",
        `Plan ready: ${name}`,
        `Plan ${relPath} status: ready`,
        meta.openBoxes
      );
    } else if (meta.status === "done") {
      await notifyPlan(
        relPath,
        "awaiting-acceptance",
        `Plan done: ${name}`,
        `Plan ${relPath} status: done — awaiting acceptance`,
        meta.openBoxes
      );
    }
    // status in-progress / accepted / draft: notify nothing
  }

  /** Idle-time best-effort scan: only remind on status: ready, debounce 60s. */
  async function scanPlansForReady() {
    if (!dir) return;
    try {
      const plansDir = path.join(dir, ".plans");
      const st = await stat(plansDir);
      if (!st.isDirectory()) return;
      const entries = await readdir(plansDir);
      for (const name of entries) {
        if (!name.endsWith(".md")) continue;
        const abs = path.join(plansDir, name);
        const rel = path.posix.join(".plans", name);
        const meta = await readPlanMeta(abs);
        if (!meta) continue;
        if (meta.status === "ready") {
          await handlePlanFile(abs, rel);
        }
      }
    } catch {
      // ignore
    }
  }

  /** Handle edit/write tool events touching .plans/*.md */
  async function handleToolEvent(event) {
    if (!dir) return;
    const type = event?.type || "";
    const tool = toolNameOf(event);
    if (!eventLooksLikeFileWrite(type, tool)) return;
    const paths = collectPaths(event, [], 0);
    for (const p of paths) {
      if (!isPlanPath(p)) continue;
      const abs = joinPlanPath(dir, p);
      const rel = path.isAbsolute(p) ? path.relative(dir, abs) : p;
      await handlePlanFile(abs, rel);
    }
  }

  return {
    // Defensive: some plugin hosts expose a config hook to announce capabilities.
    config: async () => {
      return { planflow: "installed" };
    },

    // Defensive: if a host exposes tool.call/edit/write hooks directly, accept them.
    "tool.call": async (input) => {
      try {
        if (!input) return;
        await handleToolEvent(input.event || input);
      } catch {
        /* never break */
      }
    },

    event: async ({ event } = {}) => {
      try {
        if (!event) return;
        const type = event.type || "";
        if (eventLooksLikeFileWrite(type, toolNameOf(event))) {
          await handleToolEvent(event);
        }
        if (eventLooksLikeIdle(type)) {
          // Debounce lives inside notifyPlan (60s per plan path).
          await scanPlansForReady();
        }
      } catch {
        /* never break the host session */
      }
    },
  };
};

export default PlanflowPlugin;
