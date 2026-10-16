-- recore-shipco-hub initial schema

-- 出荷ジョブ：RECOREの受注1件 or 宅配買取返送1件 = 1ジョブ
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,            -- ULID風
  kind          TEXT NOT NULL,               -- 'ec_order' | 'bad_return'
  source_id     INTEGER NOT NULL,            -- ec_order_id or bad_case_id
  store_id      INTEGER,                     -- RECORE店舗ID（bad_caseのみ確実に取れる）
  mall_id       TEXT,                        -- ec_account.mall_id
  status        TEXT NOT NULL,               -- queued | undecided | issuing | issued | written_back | done | skipped | failed
  decision_json TEXT,                        -- {carrier, service, pack_size, pack_amount, cool_options, ...}
  decision_by   TEXT,                        -- 'rule:<name>' | 'manual:<user>'
  source_json   TEXT,                        -- RECOREから取得した元データ（デバッグ用）
  shipment_id   TEXT,                        -- Ship&co shipment id
  tracking_no   TEXT,
  label_url     TEXT,
  carrier_type  TEXT,                        -- Ship&co carrier type (yamato/sagawa/...)
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Webhook冪等化
CREATE TABLE IF NOT EXISTS webhook_events (
  message_id  TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- 印刷キュー（プリントエージェントがポーリング）
CREATE TABLE IF NOT EXISTS print_queue (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  printer     TEXT NOT NULL DEFAULT 'default', -- エージェント側のプリンタ名に対応
  label_url   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | printing | done | failed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_print_status ON print_queue(status);

-- 荷姿・キャリア判定ルール（上から順に評価、最初にマッチしたものを採用）
-- match_json 例: {"mall_id":"SHOPIFY","shipping_method":"ネコポス"} / {"max_qty":3,"max_total":3000}
-- result_json 例: {"carrier":"yamato","service":"yamato_nekopos"} / {"carrier":"yamato","service":"yamato_regular","pack_size":60}
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  kind        TEXT NOT NULL DEFAULT 'ec_order',
  match_json  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 設定（店舗ごとのShip&co倉庫ID、RECORE配送業者IDの対応など）
-- key 例:
--   warehouse_id:<store_id>      → Ship&co warehouse_id
--   carrier_id:<carrier_type>    → Ship&co carrier_id（同一キャリア複数契約がある場合）
--   recore_carrier_id:<carrier_type> → RECORE側 shipping_carrier_id
--   default_printer:<store_id>   → print_queue.printer
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
