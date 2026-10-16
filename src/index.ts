import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Env } from "./env";
import { now } from "./env";
import { cancelJob, decideJob, enqueueJob, excludedMalls, findJob, getJob, processJob, retryJob, skipJob } from "./jobs";
import type { Job } from "./jobs";
import type { Decision } from "./rules";
import { scheduled } from "./scheduled";
import { UI_HTML } from "./ui";

const app = new Hono<{ Bindings: Env }>();

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function bg(c: Context<{ Bindings: Env }>, p: Promise<unknown>) {
  c.executionCtx.waitUntil(p.catch((e) => console.error("background error", e)));
}

app.get("/health", (c) => c.json({ ok: true, test_mode: c.env.SHIPANDCO_TEST_MODE === "true", at: now() }));

// ---- RECORE Webhook ------------------------------------------------------------

type AnyObj = Record<string, any>;

app.post("/webhooks/recore/:secret", async (c) => {
  if (!safeEqual(c.req.param("secret"), c.env.WEBHOOK_SECRET)) return c.text("not found", 404);

  let body: AnyObj = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: true, ignored: "invalid json" });
  }
  // ペイロード形は { topic, data } / ヘッダ指定 の両方に耐える。どちらにせよ処理時に RECORE から取り直す
  const topic: string = body.topic ?? c.req.header("X-ReCORE-Topic") ?? "";
  const data: AnyObj = body.data ?? body.payload ?? body;

  const messageId = c.req.header("X-ReCORE-Message-ID");
  if (messageId) {
    const r = await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_events (message_id, topic, received_at) VALUES (?, ?, ?)")
      .bind(messageId, topic, now())
      .run();
    if (r.meta.changes === 0) return c.json({ ok: true, duplicate: true });
  }

  if (topic === "ec.order.status.changed") {
    const id = Number(data.id ?? data.ec_order_id ?? data.ec_order?.id);
    if (!id) return c.json({ ok: true, ignored: "no order id" });
    const status: string | undefined = data.status ?? data.ec_order?.status;
    const mallId: string | undefined = data.ec_account?.mall_id ?? data.ec_order?.ec_account?.mall_id;

    if (status === "CANCELED") {
      const job = await findJob(c.env, "ec_order", id);
      if (job) bg(c, cancelJob(c.env, job));
      return c.json({ ok: true, action: job ? "cancel" : "none" });
    }
    // status 不明のペイロードでもジョブ化して processJob 側で判定する
    if (status && status !== "UNSHIPPED") return c.json({ ok: true, ignored: `status=${status}` });
    if (mallId && excludedMalls(c.env).includes(mallId)) return c.json({ ok: true, ignored: `excluded ${mallId}` });

    const job = await enqueueJob(c.env, "ec_order", id, { mall_id: mallId ?? null });
    if (job.status === "queued") bg(c, processJob(c.env, job.id));
    return c.json({ ok: true, job_id: job.id, status: job.status });
  }

  if (topic === "bad.return_status.changed") {
    const id = Number(data.id ?? data.bad_case_id ?? data.bad_case?.id);
    if (!id) return c.json({ ok: true, ignored: "no bad_case id" });
    const rs: string | undefined = data.return_status ?? data.bad_case?.return_status;
    if (rs && rs !== "REQUIRED") return c.json({ ok: true, ignored: `return_status=${rs}` });
    const storeId = Number(data.store?.id ?? data.store_id) || null;
    const job = await enqueueJob(c.env, "bad_return", id, { store_id: storeId });
    if (job.status === "queued") bg(c, processJob(c.env, job.id));
    return c.json({ ok: true, job_id: job.id, status: job.status });
  }

  return c.json({ ok: true, ignored: `topic=${topic}` });
});

// ---- 管理API（Bearer ADMIN_TOKEN） ------------------------------------------------

async function auth(c: Context<{ Bindings: Env }>, next: Next) {
  const h = c.req.header("Authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!safeEqual(token, c.env.ADMIN_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  await next();
}
app.use("/api/*", auth);

function view(j: Job) {
  const { source_json, ...rest } = j;
  let summary: AnyObj | null = null;
  try {
    const s = source_json ? JSON.parse(source_json) : null;
    if (s && j.kind === "ec_order") {
      summary = {
        mall_order_id: s.mall_order_id,
        name: s.shipping_name ?? s.buyer_name,
        pref: s.shipping_state_or_region,
        payment_method: s.payment_method,
        payment_total: s.payment_total,
        shipping_method: s.attribute?.shipping_method ?? null,
        qty: (s.goods ?? []).reduce((n: number, g: AnyObj) => n + (g.quantity ?? 0), 0),
        items: (s.goods ?? []).map((g: AnyObj) => g.title).slice(0, 5),
        comment: s.comment,
      };
    } else if (s) {
      summary = {
        code: s.code,
        name: `${s.last_name ?? ""} ${s.first_name ?? ""}`.trim(),
        pref: s.prefecture,
        store: s.store?.name,
        qty: (s.goods ?? []).filter((g: AnyObj) => !g.is_canceled).reduce((n: number, g: AnyObj) => n + g.quantity, 0),
      };
    }
  } catch {
    /* noop */
  }
  return { ...rest, decision: j.decision_json ? JSON.parse(j.decision_json) : null, summary };
}

app.get("/api/jobs", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const stmt = status
    ? c.env.DB.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, limit)
    : c.env.DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").bind(limit);
  const { results } = await stmt.all<Job>();
  return c.json(results.map(view));
});

app.get("/api/jobs/:id", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  return job ? c.json({ ...view(job), source: job.source_json ? JSON.parse(job.source_json) : null }) : c.json({ error: "not found" }, 404);
});

app.post("/api/jobs/:id/decide", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<Partial<Decision> & { by?: string }>();
  if (!b.carrier || !b.service) return c.json({ error: "carrier と service は必須" }, 400);
  const d: Decision = { carrier: b.carrier, service: b.service };
  if (b.pack_size) d.pack_size = Number(b.pack_size);
  if (b.pack_amount) d.pack_amount = Number(b.pack_amount);
  if (b.cool_options) d.cool_options = b.cool_options;
  if (!(await decideJob(c.env, job, d, `manual:${b.by ?? "ui"}`))) return c.json({ error: `status=${job.status} は決定できません` }, 409);
  bg(c, processJob(c.env, job.id));
  return c.json({ ok: true });
});

app.post("/api/jobs/:id/skip", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
  if (!(await skipJob(c.env, job, b.reason ?? "ui"))) return c.json({ error: `status=${job.status} はスキップできません` }, 409);
  return c.json({ ok: true });
});

app.post("/api/jobs/:id/retry", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  if (!(await retryJob(c.env, job))) return c.json({ error: `status=${job.status} は再試行できません` }, 409);
  bg(c, processJob(c.env, job.id));
  return c.json({ ok: true });
});

/** 手動でジョブを作る（Webhook取りこぼし時や導入時テスト用） */
app.post("/api/jobs", async (c) => {
  const b = await c.req.json<{ kind: "ec_order" | "bad_return"; source_id: number }>();
  if (!["ec_order", "bad_return"].includes(b.kind) || !b.source_id) return c.json({ error: "kind, source_id が必要" }, 400);
  const job = await enqueueJob(c.env, b.kind, Number(b.source_id));
  if (job.status === "queued") bg(c, processJob(c.env, job.id));
  return c.json({ ok: true, job_id: job.id, status: job.status });
});

// ---- 印刷キュー -----------------------------------------------------------------

/** pending を取り出して printing に（複数エージェントでも二重印刷しない） */
app.get("/api/print-queue", async (c) => {
  const printer = c.req.query("printer") ?? "default";
  const t = now();
  const { results } = await c.env.DB.prepare(
    `UPDATE print_queue SET status = 'printing', updated_at = ?
     WHERE id IN (SELECT id FROM print_queue WHERE status = 'pending' AND printer = ? ORDER BY created_at LIMIT 20)
     RETURNING id, job_id, printer, created_at`
  )
    .bind(t, printer)
    .all();
  return c.json(results);
});

/** ラベル本体。Ship&co の label が URL でも base64 でもPDFとして返す */
app.get("/api/print-queue/:id/label", async (c) => {
  const row = await c.env.DB.prepare("SELECT label_url FROM print_queue WHERE id = ?").bind(c.req.param("id")).first<{ label_url: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (/^https?:\/\//.test(row.label_url)) {
    const res = await fetch(row.label_url);
    if (!res.ok) return c.json({ error: `label fetch ${res.status}` }, 502);
    return new Response(res.body, { headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/pdf" } });
  }
  const b64 = row.label_url.replace(/^data:[^,]+,/, "");
  const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bin, { headers: { "Content-Type": "application/pdf" } });
});

for (const st of ["done", "failed"] as const) {
  app.post(`/api/print-queue/:id/${st}`, async (c) => {
    const r = await c.env.DB.prepare("UPDATE print_queue SET status = ?, updated_at = ? WHERE id = ?")
      .bind(st, now(), c.req.param("id"))
      .run();
    return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
}

/** 再印刷（failed / done を pending に戻す） */
app.post("/api/print-queue/:id/reprint", async (c) => {
  const r = await c.env.DB.prepare("UPDATE print_queue SET status = 'pending', updated_at = ? WHERE id = ?")
    .bind(now(), c.req.param("id"))
    .run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

app.get("/api/print-queue/list", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, job_id, printer, status, created_at, updated_at FROM print_queue WHERE status != 'done' ORDER BY created_at DESC LIMIT 200"
  ).all();
  return c.json(results);
});

// ---- 確認画面 -------------------------------------------------------------------

app.get("/", (c) => c.html(UI_HTML));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
