#!/usr/bin/env node
// 店舗PC常駐のプリントエージェント（Node 18+ / Mac・Linux の CUPS 前提）
//
//   HUB_URL=https://recore-shipco-hub.xxx.workers.dev \
//   ADMIN_TOKEN=xxxx \
//   PRINTER=default \            # ハブ側 print_queue.printer の値
//   LP_PRINTER=Zebra_ZD421 \     # lp -d に渡す実プリンタ名（省略時は既定プリンタ）
//   LP_OPTIONS="-o media=Custom.4.5x7.8in -o fit-to-page" \
//   node agent/print-agent.mjs
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const HUB_URL = (process.env.HUB_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN ?? "";
const PRINTER = process.env.PRINTER ?? "default";
const LP_PRINTER = process.env.LP_PRINTER ?? "";
const LP_OPTIONS = (process.env.LP_OPTIONS ?? "").split(/\s+/).filter(Boolean);
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const DRY_RUN = process.env.DRY_RUN === "1"; // 1 なら印刷せず PDF を保存して終わる

if (!HUB_URL || !TOKEN) {
  console.error("HUB_URL と ADMIN_TOKEN を設定してください");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}` };
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function hub(path, init = {}) {
  const res = await fetch(`${HUB_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res;
}

async function printOne(item, dir) {
  const pdf = Buffer.from(await (await hub(`/api/print-queue/${item.id}/label`)).arrayBuffer());
  const file = join(dir, `${item.id}.pdf`);
  await writeFile(file, pdf);
  if (DRY_RUN) {
    log("DRY_RUN saved", file);
    return;
  }
  const args = [...(LP_PRINTER ? ["-d", LP_PRINTER] : []), ...LP_OPTIONS, file];
  await run("lp", args);
}

async function tick() {
  const items = await (await hub(`/api/print-queue?printer=${encodeURIComponent(PRINTER)}`)).json();
  if (!items.length) return;
  const dir = await mkdtemp(join(tmpdir(), "hub-print-"));
  try {
    for (const item of items) {
      try {
        await printOne(item, dir);
        await hub(`/api/print-queue/${item.id}/done`, { method: "POST" });
        log("printed", item.id, "job", item.job_id);
      } catch (e) {
        log("FAILED", item.id, e.message);
        await hub(`/api/print-queue/${item.id}/failed`, { method: "POST" }).catch(() => {});
      }
    }
  } finally {
    if (!DRY_RUN) await rm(dir, { recursive: true, force: true });
  }
}

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

log(`print-agent start: hub=${HUB_URL} printer=${PRINTER} lp=${LP_PRINTER || "(default)"}`);
while (!stopping) {
  try {
    await tick();
  } catch (e) {
    log("poll error", e.message);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
