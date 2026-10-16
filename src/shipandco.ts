import type { Env } from "./env";
import { RetryableError } from "./recore";

export type ScAddress = {
  full_name: string;
  company?: string;
  email?: string;
  phone: string;
  country: string;
  zip: string;
  province: string;
  city?: string;
  address1: string;
  address2?: string;
  extra?: string;
};

export type ScSetup = {
  carrier?: string; // yamato | sagawa | yuupack | yuupacket | yuumail | seino | custom ...
  carrier_id?: string;
  service: string; // yamato_nekopos | yamato_regular | ...
  currency?: string;
  ref_number?: string;
  shipment_date?: string; // YYYY-MM-DD（yamato必須）
  date?: string; // 配達日
  time?: string; // 配達時間帯コード
  pack_size?: number;
  pack_amount?: number;
  cool_options?: "regular" | "fresh" | "frozen";
  delivery_note?: string;
  cash_on_delivery?: { amount: number; tax: number };
  test?: boolean;
};

export type ScShipmentRequest = {
  to_address: ScAddress;
  from_address?: ScAddress; // warehouse_id を setup で使う場合は省略可
  setup: ScSetup & { warehouse_id?: string };
  products: Array<{ name: string; quantity: number; price: number; sku?: string; item_id?: string }>;
};

export type ScShipmentResponse = {
  id: string;
  state: string;
  test: boolean;
  delivery: {
    carrier: string;
    method: string;
    tracking_numbers: string[];
    label: string;
    estimated_delivery_date?: string;
    warnings?: string[];
  };
};

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.SHIPANDCO_BASE_URL}${path}`, {
    method,
    headers: { "x-access-token": env.SHIPANDCO_API_TOKEN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 || res.status === 503) throw new RetryableError(`Ship&co ${res.status} on ${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Ship&co ${res.status} on ${path}: ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export const shipandco = {
  createShipment: (env: Env, req: ScShipmentRequest) => {
    if (env.SHIPANDCO_TEST_MODE === "true") req.setup.test = true;
    return call<ScShipmentResponse>(env, "POST", "/shipments", req);
  },
  getShipment: (env: Env, id: string) => call<ScShipmentResponse>(env, "GET", `/shipments/${id}`),
  deleteShipment: (env: Env, id: string) => call<string>(env, "DELETE", `/shipments/${id}`),
  listCarriers: (env: Env) => call<Array<{ id: string; type: string; state: string }>>(env, "GET", "/carriers"),
  listWarehouses: (env: Env) => call<Array<{ id: string; address: Record<string, string> }>>(env, "GET", "/warehouses"),
};
