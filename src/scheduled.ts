import type { Env } from "./env";
import { now } from "./env";
import { MAX_ATTEMPTS, processJob } from "./jobs";

/** Webhook 直後の waitUntil 処理と取り合わないよう、この秒数以上止まっているものだけ拾う */
const STALE_SEC = 120;
const KEEP_DONE_SEC = 7 * 86400;

export async function scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(run(env));
}

async function run(env: Env): Promise<void> {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT id FROM jobs
     WHERE status IN ('queued', 'issuing', 'issued', 'written_back') AND attempts < ? AND updated_at < ?
     ORDER BY updated_at ASC LIMIT 50`
  )
    .bind(MAX_ATTEMPTS, t - STALE_SEC)
    .all<{ id: string }>();

  // RECORE / Ship&co のレート制限を考えて直列で回す
  for (const r of results) {
    try {
      await processJob(env, r.id);
    } catch (e) {
      console.error("cron processJob", r.id, e);
    }
  }

  const cutoff = t - KEEP_DONE_SEC;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM print_queue WHERE status = 'done' AND job_id IN (SELECT id FROM jobs WHERE status IN ('done', 'skipped') AND updated_at < ?)"
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM jobs WHERE status IN ('done', 'skipped') AND updated_at < ? AND id NOT IN (SELECT job_id FROM print_queue)").bind(cutoff),
    env.DB.prepare("DELETE FROM webhook_events WHERE received_at < ?").bind(cutoff),
  ]);
}
