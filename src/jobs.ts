import type { Env } from "./env";
import { getSetting, newId, now } from "./env";
import { badCaseToShipment, orderToShipment } from "./mapping";
import { recore, RetryableError } from "./recore";
import type { RecoreBadCase, RecoreOrder } from "./recore";
import { decide } from "./rules";
import type { Decision } from "./rules";
import { shipandco } from "./shipandco";

export type JobKind = "ec_order" | "bad_return";
export type JobStatus =
  | "queued"
  | "undecided"
  | "issuing"
  | "issued"
  | "written_back"
  | "done"
  | "skipped"
  | "failed";

export type Job = {
  id: string;
  kind: JobKind;
  source_id: number;
  store_id: number | null;
  mall_id: string | null;
  status: JobStatus;
  decision_json: string | null;
  decision_by: string | null;
  source_json: string | null;
  shipment_id: string | null;
  tracking_no: string | null;
  label_url: string | null;
  carrier_type: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
};

export const MAX_ATTEMPTS = 5;
/** 自動スキップの error 接頭辞。再度 Webhook が来たら queued に戻してよい印 */
const AUTO = "auto:";

export function excludedMalls(env: Env): string[] {
  return (env.EXCLUDED_MALL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function getJob(env: Env, id: string): Promise<Job | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
}

export async function findJob(env: Env, kind: JobKind, sourceId: number): Promise<Job | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE kind = ? AND source_id = ?").bind(kind, sourceId).first<Job>();
}

/**
 * ジョブ作成（kind+source_id で一意）。
 * 既存が自動スキップ（auto:）で未発行なら queued に戻す。それ以外の既存ジョブはそのまま返す。
 */
export async function enqueueJob(
  env: Env,
  kind: JobKind,
  sourceId: number,
  extra: { store_id?: number | null; mall_id?: string | null } = {}
): Promise<Job> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO jobs (id, kind, source_id, store_id, mall_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
     ON CONFLICT(kind, source_id) DO UPDATE SET
       status = 'queued', error = NULL, attempts = 0, updated_at = excluded.updated_at
     WHERE jobs.status = 'skipped' AND jobs.shipment_id IS NULL AND jobs.error LIKE '${AUTO}%'`
  )
    .bind(newId(), kind, sourceId, extra.store_id ?? null, extra.mall_id ?? null, t, t)
    .run();
  return (await findJob(env, kind, sourceId))!;
}

/** status が expect のときだけ更新（楽観ロック）。更新できたら true */
async function transition(
  env: Env,
  job: Job,
  expect: JobStatus,
  patch: Partial<Omit<Job, "id" | "kind" | "source_id" | "created_at">>
): Promise<boolean> {
  const cols = Object.keys(patch);
  const sets = [...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
  const vals = cols.map((c) => (patch as Record<string, unknown>)[c] ?? null);
  // updated_at を版番号としても使うので、同一秒内でも必ず進める
  const t = Math.max(now(), job.updated_at + 1);
  const res = await env.DB.prepare(`UPDATE jobs SET ${sets} WHERE id = ? AND status = ? AND updated_at = ?`)
    .bind(...vals, t, job.id, expect, job.updated_at)
    .run();
  if (res.meta.changes !== 1) return false;
  Object.assign(job, patch, { updated_at: t });
  return true;
}

class LostRace extends Error {}

async function step(env: Env, job: Job, expect: JobStatus, patch: Parameters<typeof transition>[3]) {
  if (!(await transition(env, job, expect, patch))) throw new LostRace(`job ${job.id} は別処理が更新済み`);
}

// ---- 各段階 ------------------------------------------------------------------

/** queued → undecided | issuing | skipped */
async function stageQueued(env: Env, job: Job): Promise<void> {
  if (job.kind === "ec_order") {
    const order = await recore.getOrder(env, job.source_id);
    const base = { source_json: JSON.stringify(order), mall_id: order.ec_account.mall_id };
    if (order.status !== "UNSHIPPED") {
      return step(env, job, "queued", { ...base, status: "skipped", error: `${AUTO}status=${order.status}` });
    }
    if (excludedMalls(env).includes(order.ec_account.mall_id)) {
      return step(env, job, "queued", { ...base, status: "skipped", error: `${AUTO}excluded mall ${order.ec_account.mall_id}` });
    }
    // 手動決定済み（decide API）ならそれを優先
    if (job.decision_json) return step(env, job, "queued", { ...base, status: "issuing", error: null });
    const r = await decide(env, order);
    if (!r) return step(env, job, "queued", { ...base, status: "undecided", error: null });
    return step(env, job, "queued", {
      ...base,
      status: "issuing",
      decision_json: JSON.stringify(r.decision),
      decision_by: r.by,
      error: null,
    });
  }

  const bc = await recore.getBadCase(env, job.source_id);
  const base = { source_json: JSON.stringify(bc), store_id: bc.store.id };
  if (bc.return_status !== "REQUIRED") {
    return step(env, job, "queued", { ...base, status: "skipped", error: `${AUTO}return_status=${bc.return_status}` });
  }
  if (job.decision_json) return step(env, job, "queued", { ...base, status: "issuing", error: null });
  // 返送の荷姿は settings の既定値（decision:bad_return:<store_id> → decision:bad_return）。なければ確認画面へ
  const raw =
    (await getSetting(env, `decision:bad_return:${bc.store.id}`)) ?? (await getSetting(env, "decision:bad_return"));
  if (!raw) return step(env, job, "queued", { ...base, status: "undecided", error: null });
  return step(env, job, "queued", {
    ...base,
    status: "issuing",
    decision_json: raw,
    decision_by: "setting:decision:bad_return",
    error: null,
  });
}

/** issuing → issued（Ship&co に送り状発行） */
async function stageIssuing(env: Env, job: Job): Promise<void> {
  if (job.shipment_id) return step(env, job, "issuing", { status: "issued" });
  const d = JSON.parse(job.decision_json!) as Decision;

  let req;
  if (job.kind === "ec_order") {
    // 発行直前に取り直す（キャンセル・出荷済みの取りこぼし防止）
    const order = await recore.getOrder(env, job.source_id);
    if (order.status !== "UNSHIPPED") {
      return step(env, job, "issuing", { status: "skipped", error: `${AUTO}status=${order.status}` });
    }
    req = await orderToShipment(env, order, d);
  } else {
    const bc = await recore.getBadCase(env, job.source_id);
    if (bc.return_status !== "REQUIRED") {
      return step(env, job, "issuing", { status: "skipped", error: `${AUTO}return_status=${bc.return_status}` });
    }
    req = await badCaseToShipment(env, bc, d);
  }

  // 発行前に updated_at を進めて「この処理が発行権を持つ」ことを確定させる（二重発行防止）
  await step(env, job, "issuing", {});
  const res = await shipandco.createShipment(env, req);
  const tracking = res.delivery?.tracking_numbers?.[0] ?? null;
  // ここで D1 更新に失敗すると Ship&co 側に孤児ラベルが残る。ref_number（RC-/BD-）で突合する
  await step(env, job, "issuing", {
    status: "issued",
    shipment_id: res.id,
    tracking_no: tracking,
    label_url: res.delivery?.label ?? null,
    carrier_type: res.delivery?.carrier ?? d.carrier,
    error: res.delivery?.warnings?.length ? `warn:${res.delivery.warnings.join(" / ")}` : null,
  });
}

async function recoreCarrierId(env: Env, carrierType: string): Promise<number | null> {
  const v = await getSetting(env, `recore_carrier_id:${carrierType}`);
  return v ? Number(v) : null;
}

/** issued → written_back（RECORE に追跡番号を書き戻し） */
async function stageIssued(env: Env, job: Job): Promise<void> {
  if (!job.tracking_no) throw new Error("tracking_number が空のため書き戻せません（Ship&co の発行結果を確認）");
  if (job.kind === "ec_order") {
    const order: RecoreOrder = await recore.getOrder(env, job.source_id);
    // 再試行時に既に書き戻し済みなら二重登録しない
    const already = order.fulfillments.some((f) => f.tracking_number === job.tracking_no);
    if (!already && order.status === "UNSHIPPED") {
      const cid = await recoreCarrierId(env, job.carrier_type ?? "");
      await recore.createFulfillment(env, order, cid, job.tracking_no, `Ship&co ${job.shipment_id}`);
    } else if (!already) {
      throw new Error(`RECORE受注が ${order.status} のため出荷登録できません（ラベル発行済み: ${job.tracking_no}）`);
    }
  } else {
    const bc: RecoreBadCase = await recore.getBadCase(env, job.source_id);
    if (bc.return_status !== "RETURNED") await recore.setBadReturned(env, job.source_id);
  }
  await step(env, job, "issued", { status: "written_back" });
}

/** written_back → done（印刷キュー投入） */
async function stageWrittenBack(env: Env, job: Job): Promise<void> {
  if (job.label_url) {
    const exists = await env.DB.prepare("SELECT 1 FROM print_queue WHERE job_id = ?").bind(job.id).first();
    if (!exists) {
      const printer =
        (job.store_id ? await getSetting(env, `default_printer:${job.store_id}`) : null) ??
        (await getSetting(env, "default_printer:default")) ??
        "default";
      const t = now();
      await env.DB.prepare(
        "INSERT INTO print_queue (id, job_id, printer, label_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
      )
        .bind(newId(), job.id, printer, job.label_url, t, t)
        .run();
    }
  }
  await step(env, job, "written_back", { status: "done" });
}

const STAGES: Partial<Record<JobStatus, (env: Env, job: Job) => Promise<void>>> = {
  queued: stageQueued,
  issuing: stageIssuing,
  issued: stageIssued,
  written_back: stageWrittenBack,
};

/** 止まる状態（undecided/done/skipped/failed）まで進める */
export async function processJob(env: Env, id: string): Promise<Job | null> {
  const job = await getJob(env, id);
  if (!job) return null;
  for (let guard = 0; guard < 8; guard++) {
    const fn = STAGES[job.status];
    if (!fn) break;
    const at = job.status;
    try {
      await fn(env, job);
    } catch (e) {
      if (e instanceof LostRace) break;
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = job.attempts + 1;
      if (e instanceof RetryableError && attempts < MAX_ATTEMPTS) {
        // status はそのまま。cron が拾い直す
        await transition(env, job, at, { attempts, error: `retry:${msg}` });
      } else {
        await transition(env, job, at, { attempts, status: "failed", error: `[${at}] ${msg}` });
      }
      break;
    }
  }
  return job;
}

// ---- 操作系（API から呼ぶ） ----------------------------------------------------

/** 確認画面で荷姿を決定 → queued に戻して処理 */
export async function decideJob(env: Env, job: Job, d: Decision, by: string): Promise<boolean> {
  if (job.status !== "undecided" && !(job.status === "failed" && !job.shipment_id)) return false;
  return transition(env, job, job.status, {
    status: "queued",
    decision_json: JSON.stringify(d),
    decision_by: by,
    error: null,
    attempts: 0,
  });
}

export async function skipJob(env: Env, job: Job, reason: string): Promise<boolean> {
  if (job.shipment_id) return false; // 発行済みは cancel 経由で消す
  if (!["queued", "undecided", "failed"].includes(job.status)) return false;
  return transition(env, job, job.status, { status: "skipped", error: `manual:${reason}` });
}

/** failed からの再試行。発行済みなら書き戻しから、未発行なら最初から */
export async function retryJob(env: Env, job: Job): Promise<boolean> {
  if (job.status !== "failed") return false;
  const status: JobStatus = job.shipment_id ? "issued" : "queued";
  return transition(env, job, "failed", { status, attempts: 0, error: null });
}

/**
 * RECORE側でキャンセルされた受注：未書き戻しのラベルは Ship&co から削除、未印刷キューも取り消す。
 * 書き戻し後（RECOREでSHIPPED）のキャンセルはここでは扱わない（手動対応）。
 */
export async function cancelJob(env: Env, job: Job): Promise<string> {
  if (["done", "written_back", "skipped"].includes(job.status)) return `noop:${job.status}`;
  if (job.shipment_id) {
    await shipandco.deleteShipment(env, job.shipment_id);
    await env.DB.prepare("UPDATE print_queue SET status = 'failed', updated_at = ? WHERE job_id = ? AND status = 'pending'")
      .bind(now(), job.id)
      .run();
  }
  const ok = await transition(env, job, job.status, { status: "skipped", error: `${AUTO}canceled` });
  return ok ? "canceled" : "race";
}
