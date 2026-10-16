# recore-shipco-hub — 引き継ぎメモ（2026-10-16）

仮名。RECOREの受注／宅配買取返送をトリガーに Ship&co で送り状を発行し、追跡番号を RECORE に書き戻すハブ。
スタック: Cloudflare Workers + Hono + D1 + KV（Telesatei / ELT と同系）。

## できているもの
- `wrangler.toml` … D1/KV バインディング、5分cron、vars（TEST_MODE, EXCLUDED_MALL_IDS）
- `migrations/0001_init.sql` … jobs / webhook_events / print_queue / rules / settings
- `src/env.ts` … Env型、newId、getSetting
- `src/recore.ts` … co-api クライアント（getOrder, createFulfillment, getBadCase, setBadReturned, webhook登録）
- `src/shipandco.ts` … createShipment（TEST_MODEで setup.test=true）, deleteShipment, listCarriers, listWarehouses
- `src/rules.ts` … D1の rules テーブルを優先順に評価して Decision を返す。未マッチ=null → undecided
- `src/mapping.ts` … RECORE受注/宅配買取ケース → Ship&co shipment リクエスト（住所結合、配達日時コード変換、代引き判定、warehouse/carrier_id を settings から解決）

## 2026-10-16 追記：1〜5 実装済み
- `src/jobs.ts` … queued→issuing→issued→written_back→done。updated_at を版番号にした楽観ロックで二重発行防止。
  - 宅配買取返送の荷姿は settings `decision:bad_return:<store_id>` → `decision:bad_return`（Decision JSON）。なければ undecided。
  - 自動スキップは error `auto:` 接頭辞。同じ受注に再度 UNSHIPPED が来たら queued に戻る。手動スキップ（`manual:`）は戻らない。
  - 書き戻しは RECORE の fulfillments に同じ追跡番号があれば二重登録しない。
  - RECORE は通信エラー・429・5xx を再試行。Ship&co の POST /shipments の通信エラーは再試行しない（ref_number で突合して手動）。
- `src/index.ts` … 上記ルートに加え `POST /api/jobs`（手動ジョブ作成）、`POST /api/jobs/:id/retry`、
  `GET /api/print-queue/:id/label`（ラベルPDFの中継。URL/base64両対応）、`POST /api/print-queue/:id/reprint`、`GET /api/print-queue/list`、`GET /`（確認画面）。
- `src/scheduled.ts` … queued/issuing/issued/written_back で2分以上停滞・attempts<5 を直列再処理。7日超の done/skipped と webhook_events を掃除。
- `agent/print-agent.mjs` … 使い方はファイル冒頭。`DRY_RUN=1` で印刷せずPDF保存。
- 未着手: Shopify `shipping_lines` → 受注属性 `shipping_method` アダプタ。RECORE Webhook の実ペイロード形の確認（現状は `{topic,data}` とヘッダ両対応、処理時にAPIから取り直す）。

## これから（この順で）
1. `src/jobs.ts` … ジョブ処理パイプライン
   - queued → decide() → (undecided で停止 | issuing) → Ship&co createShipment → issued → RECORE createFulfillment（ec_order）/ setBadReturned（bad_return）→ written_back → print_queue 投入 → done
   - 各段階でD1更新、RetryableError は attempts++ で cron 再試行、それ以外は failed
   - ref_number `RC-<ec_order_id>` / `BD-<code>` で Ship&co 側と突合可能に
2. `src/index.ts` … Hono ルート
   - `POST /webhooks/recore/:secret` … 即200、`X-ReCORE-Message-ID` で冪等化、トピック別にジョブ作成し `waitUntil` で処理
     - `ec.order.status.changed` → status==UNSHIPPED かつ mall_id が EXCLUDED でなければ kind=ec_order
     - `bad.return_status.changed` → return_status==REQUIRED で kind=bad_return
     - `ec.order.status.changed` で CANCELED → 未出荷ジョブがあれば Ship&co deleteShipment
   - `GET /api/jobs?status=undecided` / `POST /api/jobs/:id/decide` {carrier,service,pack_size} / `POST /api/jobs/:id/skip`
   - `GET /api/print-queue?printer=` / `POST /api/print-queue/:id/done|failed`（Bearer ADMIN_TOKEN）
   - `GET /health`
3. `src/scheduled.ts` … cron: queued/issuing で attempts<5 を再処理、1週間超の done を掃除
4. `agent/print-agent.mjs` … Node常駐。`GET /api/print-queue` をポーリング → PDF取得 → `lp -d <printer>` → done 報告。Mac/Linux想定。
5. 最小の確認画面（undecided 一覧で carrier/service/pack_size を選んで決定）— Worker から静的配信

## 設計上の決定事項
- 印刷はハブの責務（Ship&coの自動印刷は海外3社ZPLのみ）。プリントエージェント方式。
- メルカリShops: らくらくメルカリ便は対象外（EXCLUDED_MALL_IDS）。メルカリBiz配送に切り替えた場合は別アダプタ（後回し）。
- 配送方法は RECORE 公開APIが返さない → 当面は Shopify Admin API から `shipping_lines[0].title` を引いて受注属性 `shipping_method` に書く（`PUT /ec/orders/{id}` attribute）アダプタを用意。並行して NOVASTO に `GET /ec/orders` へ shipping_method 追加を依頼。
- Undecided（配送方法なし）は自動発行しない。必ず確認画面に落とす。
- ラベル発行はアダプタ化（将来: ヤマトB2直結 / メルカリBiz配送 / eBay経路は ECゲートウェイ）。
- eBay をやる場合、RECOREは在庫の真実で売上の真実ではない（金額は整数円・概算）。USD原値とレートは受注属性に残す。

## 初期導入先: フルコンプ（先月1,391件 → Ship&co 月約3万円）
### settings に入れる値
- `warehouse_id:default` … Ship&co の倉庫ID（GET /warehouses）
- `carrier_id:yamato` … 同一キャリア複数契約がある場合のみ
- `recore_carrier_id:yamato` … RECORE側 shipping_carrier_id（NOVASTOに確認）
- `default_printer:default` … エージェント側プリンタ名
### rules 初期案（フルコンプ想定）
1. shipping_method に "ネコポス" → yamato / yamato_nekopos
2. shipping_method に "コンパクト" → yamato / yamato_taqbin（要確認：コンパクトのservice値）
3. shipping_method に "宅急便" → yamato / yamato_regular, pack_size 60
4. マッチなし → undecided

## 要確認（外部）
- NOVASTO: APIキー発行・スコープ（ec:order:index/show/fulfillment:store, bad_case:show/return_status:update, webhook:*）、shipping_carrier_id 一覧、GET /ec/orders への shipping_method 追加
- Ship&co: API利用で料金が変わらないか、ヤマトの print.size（サーマル PDF_4.5X7.8 を使うか）
- フルコンプ: メルカリShops の配送方法（らくらく or Biz）、Shopify Admin API のトークン、店舗PCに常駐エージェントを置けるか

## 秘密情報（wrangler secret put）
RECORE_API_KEY / SHIPANDCO_API_TOKEN / WEBHOOK_SECRET / ADMIN_TOKEN

## 参照
- Ship&co API: https://developer.shipandco.com/
- RECORE co-api: https://novasto.github.io/ReCORE.co-api/spec/
- RECORE 出荷フロー: https://docs.channel.io/helprecore/ja/articles/r0010-45a57f95
