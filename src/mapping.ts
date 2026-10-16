import type { Env } from "./env";
import { getSetting } from "./env";
import type { RecoreBadCase, RecoreOrder } from "./recore";
import type { Decision } from "./rules";
import type { ScShipmentRequest } from "./shipandco";

const JST_OFFSET = 9 * 3600;

function jstDate(epoch: number): string {
  return new Date((epoch + JST_OFFSET) * 1000).toISOString().slice(0, 10);
}
function jstHour(epoch: number): number {
  return new Date((epoch + JST_OFFSET) * 1000).getUTCHours();
}
export function todayJst(): string {
  return jstDate(Math.floor(Date.now() / 1000));
}

/**
 * RECOREの配送日時指定（earliest/latest の epoch）→ Ship&co の date / time コード。
 * 日付未指定は 1970-01-01 が入ってくるので弾く。
 */
export function deliveryWindow(order: RecoreOrder, carrier: string): { date?: string; time?: string } {
  const e = order.earliest_delivery_at;
  const l = order.latest_delivery_at;
  if (!e || e < 86400 * 365) return {};
  const date = jstDate(e);
  const h0 = jstHour(e);
  const h1 = l && l > e ? jstHour(l) : h0;
  const span = `${h0}-${h1}`;
  const table: Record<string, Record<string, string>> = {
    yamato: { "0-12": "before-noon", "9-12": "before-noon", "14-16": "14-16", "16-18": "16-18", "18-20": "18-20", "19-21": "19-21" },
    sagawa: { "0-12": "before-noon", "9-12": "before-noon", "12-14": "12-14", "14-16": "14-16", "16-18": "16-18", "18-20": "18-20", "18-21": "18-21", "19-21": "19-21" },
    yuupack: { "0-12": "before-noon", "9-12": "before-noon", "12-14": "12-14", "14-16": "14-16", "16-18": "16-18", "18-20": "18-20", "19-21": "19-21" },
  };
  const time = table[carrier]?.[span];
  return time ? { date, time } : { date };
}

/** 代引き判定：支払方法の文字列に「代引」「代金引換」「COD」が含まれていれば代引き */
export function codOf(order: RecoreOrder): { amount: number; tax: number } | undefined {
  const pm = (order.payment_method ?? "").toLowerCase();
  if (/代引|代金引換|cod/.test(pm)) {
    return { amount: order.payment_total, tax: 0 };
  }
  return undefined;
}

function joinAddress(order: RecoreOrder): { address1: string; address2?: string } {
  const a1 = [order.shipping_city, order.shipping_address1].filter(Boolean).join("");
  const a2 = [order.shipping_address2, order.shipping_address3].filter(Boolean).join(" ");
  return { address1: a1, address2: a2 || undefined };
}

export async function orderToShipment(env: Env, order: RecoreOrder, d: Decision): Promise<ScShipmentRequest> {
  const storeId = await getSetting(env, `store_id:mall:${order.ec_account.mall_id}`);
  const warehouseId = (await getSetting(env, `warehouse_id:${storeId ?? "default"}`)) ?? (await getSetting(env, "warehouse_id:default"));
  if (!warehouseId) throw new Error("settings に warehouse_id:default がありません");
  const carrierId = await getSetting(env, `carrier_id:${d.carrier}`);

  const { address1, address2 } = joinAddress(order);
  const win = deliveryWindow(order, d.carrier);
  const products = order.goods
    .filter((g) => g.quantity - g.shipped_quantity > 0)
    .map((g) => ({
      name: (g.title ?? "商品").slice(0, 60),
      quantity: g.quantity - g.shipped_quantity,
      price: g.unit_price,
      sku: g.mall_item_code ?? undefined,
    }));

  const req: ScShipmentRequest = {
    to_address: {
      full_name: order.shipping_name ?? order.buyer_name ?? "",
      phone: order.shipping_phone ?? "",
      email: order.buyer_email ?? undefined,
      country: order.shipping_country_code ?? "JP",
      zip: (order.shipping_postal_code ?? "").replace("-", ""),
      province: order.shipping_state_or_region ?? "",
      address1,
      address2,
    },
    setup: {
      carrier: d.carrier,
      carrier_id: carrierId ?? undefined,
      service: d.service,
      warehouse_id: warehouseId,
      currency: "JPY",
      ref_number: `RC-${order.id}`,
      shipment_date: todayJst(),
      pack_size: d.pack_size,
      pack_amount: d.pack_amount ?? 1,
      cool_options: d.cool_options,
      delivery_note: order.comment?.slice(0, 100) || undefined,
      cash_on_delivery: codOf(order),
      ...win,
    },
    products,
  };
  return req;
}

/** 宅配買取の返送：店舗 → 申込者 */
export async function badCaseToShipment(env: Env, bc: RecoreBadCase, d: Decision): Promise<ScShipmentRequest> {
  const warehouseId = (await getSetting(env, `warehouse_id:${bc.store.id}`)) ?? (await getSetting(env, "warehouse_id:default"));
  if (!warehouseId) throw new Error("settings に warehouse_id:default がありません");
  const carrierId = await getSetting(env, `carrier_id:${d.carrier}`);
  const items = bc.goods.filter((g) => !g.is_canceled).reduce((s, g) => s + g.quantity, 0) || 1;
  return {
    to_address: {
      full_name: `${bc.last_name ?? ""} ${bc.first_name ?? ""}`.trim(),
      phone: bc.tel ?? "",
      email: bc.email ?? undefined,
      country: "JP",
      zip: (bc.postal_code ?? "").replace("-", ""),
      province: bc.prefecture ?? "",
      address1: bc.address1 ?? "",
      address2: bc.address2 ?? undefined,
    },
    setup: {
      carrier: d.carrier,
      carrier_id: carrierId ?? undefined,
      service: d.service,
      warehouse_id: warehouseId,
      currency: "JPY",
      ref_number: `BD-${bc.code}`,
      shipment_date: todayJst(),
      pack_size: d.pack_size,
      pack_amount: d.pack_amount ?? 1,
    },
    products: [{ name: "買取不成立品の返送", quantity: items, price: 0 }],
  };
}
