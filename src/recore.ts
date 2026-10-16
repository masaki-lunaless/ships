import type { Env } from "./env";

// ---- RECORE co-api 型（必要な部分だけ） ----------------------------------
export type RecoreOrder = {
  id: number;
  ec_account: { id: number; mall_id: string };
  mall_order_id: string;
  status: "PENDING" | "UNSHIPPED" | "SHIPPED" | "CANCELED" | "OTHER";
  sub_status: string | null;
  payment_total: number;
  payment_method: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  shipping_postal_code: string | null;
  shipping_country_code: string | null;
  shipping_state_or_region: string | null;
  shipping_city: string | null;
  shipping_address1: string | null;
  shipping_address2: string | null;
  shipping_address3: string | null;
  shipping_phone: string | null;
  shipping_name: string | null;
  earliest_delivery_at: number | null;
  latest_delivery_at: number | null;
  comment: string | null;
  attribute: Record<string, string> | null;
  goods: Array<{
    id: number;
    title: string | null;
    unit_price: number;
    quantity: number;
    shipped_quantity: number;
    mall_item_code: string | null;
    shipping_price: number;
    payment_price: number;
  }>;
  fulfillments: Array<{ id: number; tracking_number: string | null; shipping_carrier: { id: number; type: string } | null }>;
};

export type RecoreBadCase = {
  id: number;
  code: string;
  store: { id: number; name: string };
  status: string;
  return_status: "NOT_REQUIRED" | "REQUIRED" | "RETURNED";
  last_name: string | null;
  first_name: string | null;
  postal_code: string | null;
  prefecture: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  email: string | null;
  goods: Array<{ id: number; product_id: number; quantity: number; is_canceled: boolean }>;
};

// ---- クライアント ---------------------------------------------------------
async function call<T>(env: Env, method: string, path: string, body?: unknown, storeId?: number): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: env.RECORE_API_KEY,
    "Content-Type": "application/json",
  };
  if (storeId) headers["X-Store-Id"] = String(storeId);
  const res = await fetch(`${env.RECORE_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) throw new RetryableError(`RECORE 429 on ${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RECORE ${res.status} on ${path}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class RetryableError extends Error {}

export const recore = {
  getOrder: (env: Env, id: number) => call<RecoreOrder>(env, "GET", `/ec/orders/${id}`),

  /** 出荷登録：UNSHIPPED→SHIPPED。全量出荷で確定、モールへ出荷通知が流れる */
  createFulfillment: (
    env: Env,
    order: RecoreOrder,
    shippingCarrierId: number | null,
    trackingNumber: string,
    note?: string
  ) =>
    call<void>(env, "POST", "/ec/orders/fulfillments", [
      {
        ec_order_id: order.id,
        shipping_carrier_id: shippingCarrierId,
        tracking_number: trackingNumber,
        note: note ?? null,
        goods: order.goods
          .filter((g) => g.quantity - g.shipped_quantity > 0)
          .map((g) => ({ ec_order_goods_id: g.id, quantity: g.quantity - g.shipped_quantity })),
      },
    ]),

  getBadCase: (env: Env, id: number) => call<RecoreBadCase>(env, "GET", `/bad_cases/${id}`),

  setBadReturned: (env: Env, id: number) =>
    call<RecoreBadCase>(env, "PUT", `/bad_cases/${id}/return_status`, { return_status: "RETURNED" }),

  /** ケースメモに追跡番号を残す（返送ステータスには番号欄がないため） */
  appendBadCaseNote: async (env: Env, bc: RecoreBadCase, line: string) =>
    call<RecoreBadCase>(env, "PUT", `/bad_cases/${bc.id}`, { note: line }),

  registerWebhook: (env: Env, address: string, topics: string[]) =>
    call<{ id: string }>(env, "POST", "/webhooks", { address, topics }),

  listWebhooks: (env: Env) => call<Array<{ id: string; address: string; topics: string[] }>>(env, "GET", "/webhooks"),
};
