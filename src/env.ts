export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  RECORE_BASE_URL: string;
  SHIPANDCO_BASE_URL: string;
  SHIPANDCO_TEST_MODE: string;
  EXCLUDED_MALL_IDS: string;
  RECORE_API_KEY: string;
  SHIPANDCO_API_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
};

export const now = () => Math.floor(Date.now() / 1000);

// ULID風の時系列ソート可能ID（依存なし）
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = crypto.getRandomValues(new Uint8Array(8));
  return t + Array.from(r, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}
