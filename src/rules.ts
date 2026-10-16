import type { Env } from "./env";
import type { RecoreOrder } from "./recore";

/** 荷姿・キャリアの決定結果。Ship&co setup に渡す値そのもの */
export type Decision = {
  carrier: string;
  service: string;
  pack_size?: number;
  pack_amount?: number;
  cool_options?: "regular" | "fresh" | "frozen";
};

export type RuleMatch = {
  mall_id?: string; // ec_account.mall_id 完全一致
  shipping_method?: string; // 受注属性 shipping_method（部分一致、小文字比較）
  payment_method?: string; // 部分一致
  max_qty?: number; // 合計数量 <=
  min_qty?: number;
  max_total?: number; // payment_total <=
  min_total?: number;
  country?: string; // shipping_country_code
};

type Rule = { id: number; name: string; priority: number; match_json: string; result_json: string };

/**
 * 受注の配送方法を取り出す。
 * 1) 受注属性 attribute.shipping_method（ゲートウェイ受注 or 外部で書き込んだもの）
 * 2) なければ null（RECORE公開APIは通常受注の配送方法を返さない）
 */
export function shippingMethodOf(order: RecoreOrder): string | null {
  const v = order.attribute?.shipping_method ?? order.attribute?.oa_shipping_method ?? null;
  if (!v || v.toLowerCase() === "undecided") return null;
  return v;
}

function matches(m: RuleMatch, order: RecoreOrder): boolean {
  const qty = order.goods.reduce((s, g) => s + g.quantity, 0);
  const sm = (shippingMethodOf(order) ?? "").toLowerCase();
  const pm = (order.payment_method ?? "").toLowerCase();
  if (m.mall_id && m.mall_id !== order.ec_account.mall_id) return false;
  if (m.shipping_method && !sm.includes(m.shipping_method.toLowerCase())) return false;
  if (m.payment_method && !pm.includes(m.payment_method.toLowerCase())) return false;
  if (m.max_qty !== undefined && qty > m.max_qty) return false;
  if (m.min_qty !== undefined && qty < m.min_qty) return false;
  if (m.max_total !== undefined && order.payment_total > m.max_total) return false;
  if (m.min_total !== undefined && order.payment_total < m.min_total) return false;
  if (m.country && m.country !== (order.shipping_country_code ?? "JP")) return false;
  return true;
}

/** ルールを上から評価。マッチなしなら null（= undecided、確認画面へ） */
export async function decide(env: Env, order: RecoreOrder): Promise<{ decision: Decision; by: string } | null> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, priority, match_json, result_json FROM rules WHERE enabled = 1 AND kind = 'ec_order' ORDER BY priority ASC, id ASC"
  ).all<Rule>();
  for (const r of results) {
    let m: RuleMatch;
    try {
      m = JSON.parse(r.match_json);
    } catch {
      continue;
    }
    if (matches(m, order)) {
      return { decision: JSON.parse(r.result_json) as Decision, by: `rule:${r.name}` };
    }
  }
  return null;
}
