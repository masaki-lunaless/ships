// 最小の確認画面（undecided の荷姿決定・failed の再試行・印刷キュー確認）
export const UI_HTML = /* html */ `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>出荷ハブ</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#ddd; --accent:#0a6; --warn:#c50; --chip:#f2f2f2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151515; --fg:#eee; --muted:#999; --line:#333; --chip:#222; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; }
  header { display:flex; gap:8px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0 12px 0 0; }
  nav button.on { background:var(--fg); color:var(--bg); }
  button { font:inherit; padding:4px 10px; border:1px solid var(--line); background:var(--chip); color:var(--fg); border-radius:6px; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  input, select { font:inherit; padding:3px 6px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  main { padding:12px 16px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .muted { color:var(--muted); font-size:12px; }
  .err { color:var(--warn); font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .tag { background:var(--chip); border-radius:4px; padding:0 6px; font-size:12px; }
  #msg { margin-left:auto; font-size:12px; }
</style></head>
<body>
<header>
  <h1>出荷ハブ</h1>
  <nav class="row" id="tabs">
    <button data-t="undecided">未決定</button>
    <button data-t="failed">失敗</button>
    <button data-t="all">直近</button>
    <button data-t="print">印刷キュー</button>
  </nav>
  <input id="token" type="password" placeholder="ADMIN_TOKEN" size="14">
  <span id="msg" class="muted"></span>
</header>
<main id="list"></main>
<datalist id="services">
  <option value="yamato_nekopos"><option value="yamato_regular"><option value="yamato_taqbin"><option value="yamato_compact">
  <option value="sagawa_regular"><option value="yuupack_regular"><option value="yuupacket_regular">
</datalist>
<script>
const $ = (s, el = document) => el.querySelector(s);
const tokenEl = $("#token");
try { tokenEl.value = localStorage.getItem("hub_token") || ""; } catch {}
tokenEl.addEventListener("change", () => { try { localStorage.setItem("hub_token", tokenEl.value); } catch {} load(); });
let tab = "undecided";
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; load(); }));

async function api(path, opt = {}) {
  const res = await fetch(path, { ...opt, headers: { Authorization: "Bearer " + tokenEl.value, "Content-Type": "application/json" } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.status);
  return j;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ts = (t) => new Date(t * 1000).toLocaleString("ja-JP");
const say = (t) => ($("#msg").textContent = t);

async function load() {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
  const list = $("#list");
  if (!tokenEl.value) { list.innerHTML = '<p class="muted">ADMIN_TOKEN を入力してください</p>'; return; }
  try {
    if (tab === "print") return renderPrint(await api("/api/print-queue/list"));
    const q = tab === "all" ? "" : "?status=" + tab;
    renderJobs(await api("/api/jobs" + q));
    say("更新 " + new Date().toLocaleTimeString("ja-JP"));
  } catch (e) { list.innerHTML = '<p class="err">' + esc(e.message) + "</p>"; }
}

function renderJobs(jobs) {
  const list = $("#list");
  if (!jobs.length) { list.innerHTML = '<p class="muted">該当なし</p>'; return; }
  list.innerHTML = jobs.map((j) => {
    const s = j.summary || {};
    const head = j.kind === "ec_order"
      ? "受注 #" + j.source_id + " <span class='tag'>" + esc(j.mall_id) + "</span> " + esc(s.mall_order_id)
      : "買取返送 " + esc(s.code || j.source_id) + " <span class='tag'>" + esc(s.store) + "</span>";
    const info = [s.name, s.pref, s.qty != null ? s.qty + "点" : "", s.payment_method, s.payment_total != null ? "¥" + s.payment_total : "", s.shipping_method ? "配送: " + s.shipping_method : "配送方法なし"]
      .filter(Boolean).map(esc).join(" / ");
    const d = j.decision;
    const canDecide = j.status === "undecided" || (j.status === "failed" && !j.shipment_id);
    const form = canDecide ? \`
      <form class="row" data-id="\${j.id}" style="margin-top:6px">
        <select name="carrier">\${["yamato","sagawa","yuupack","yuupacket"].map((c) => \`<option \${d && d.carrier===c?"selected":""}>\${c}</option>\`).join("")}</select>
        <input name="service" list="services" placeholder="service" value="\${esc(d ? d.service : "yamato_regular")}" size="16" required>
        <select name="pack_size"><option value="">サイズ</option>\${[60,80,100,120,140,160].map((n) => \`<option \${d && d.pack_size==n?"selected":""}>\${n}</option>\`).join("")}</select>
        <select name="cool_options"><option value="">常温</option><option value="fresh">冷蔵</option><option value="frozen">冷凍</option></select>
        <button class="primary">決定して発行</button>
        <button type="button" data-act="skip">スキップ</button>
      </form>\` : "";
    const retry = j.status === "failed" ? \`<button data-act="retry" data-id="\${j.id}">\${j.shipment_id ? "書き戻しを再試行" : "最初から再試行"}</button>\` : "";
    return \`<div class="card">
      <div class="row"><strong>\${head}</strong><span class="tag">\${esc(j.status)}</span><span class="muted">\${ts(j.created_at)}</span></div>
      <div>\${info}</div>
      \${s.items ? '<div class="muted">' + s.items.map(esc).join(" ／ ") + "</div>" : ""}
      \${s.comment ? '<div class="muted">備考: ' + esc(s.comment) + "</div>" : ""}
      \${d ? '<div class="muted">決定: ' + esc(d.carrier + " / " + d.service + (d.pack_size ? " / " + d.pack_size : "")) + " (" + esc(j.decision_by) + ")</div>" : ""}
      \${j.tracking_no ? '<div class="muted">追跡番号: ' + esc(j.tracking_no) + "</div>" : ""}
      \${j.error ? '<div class="err">' + esc(j.error) + "</div>" : ""}
      \${form}\${retry}
    </div>\`;
  }).join("");

  list.querySelectorAll("form").forEach((f) => {
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      Object.keys(body).forEach((k) => body[k] === "" && delete body[k]);
      try { await api("/api/jobs/" + f.dataset.id + "/decide", { method: "POST", body: JSON.stringify(body) }); say("決定しました"); setTimeout(load, 1500); }
      catch (e) { say("エラー: " + e.message); }
    });
    f.querySelector('[data-act="skip"]').addEventListener("click", async () => {
      if (!confirm("このジョブをスキップしますか？（送り状は発行されません）")) return;
      try { await api("/api/jobs/" + f.dataset.id + "/skip", { method: "POST", body: "{}" }); load(); } catch (e) { say("エラー: " + e.message); }
    });
  });
  list.querySelectorAll('[data-act="retry"]').forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/jobs/" + b.dataset.id + "/retry", { method: "POST" }); say("再試行しました"); setTimeout(load, 1500); } catch (e) { say("エラー: " + e.message); }
  }));
}

function renderPrint(rows) {
  const list = $("#list");
  if (!rows.length) { list.innerHTML = '<p class="muted">未完了の印刷なし</p>'; return; }
  list.innerHTML = rows.map((r) => \`<div class="card row">
    <span class="tag">\${esc(r.status)}</span><span>\${esc(r.printer)}</span><span class="muted">job \${esc(r.job_id)} / \${ts(r.created_at)}</span>
    <button data-id="\${r.id}" style="margin-left:auto">再印刷</button></div>\`).join("");
  list.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/print-queue/" + b.dataset.id + "/reprint", { method: "POST" }); load(); } catch (e) { say("エラー: " + e.message); }
  }));
}

load();
// 入力中は再描画しない
setInterval(() => { if (!document.activeElement || !document.activeElement.closest("form")) load(); }, 30000);
</script>
</body></html>`;
