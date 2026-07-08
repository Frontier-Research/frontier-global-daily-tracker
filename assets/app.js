/* ============================================================================
   Frontier Global Daily Tracker
   Reads only same-origin JSON committed by the GitHub Action. Every value that
   reaches the DOM goes through textContent or a validated attribute — never
   innerHTML — so there is no HTML-injection surface. Date inputs are format-
   validated before use.
   ========================================================================== */
"use strict";

(function () {
  const DATA = "data/";
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  /* Line colours tuned for a white background, kept in each group's family. */
  const LINE = {
    dow_jones: "#FF6A00", sp500: "#E08A00", nasdaq: "#F26D2B",
    us10y: "#DB4B45",
    eem: "#B23A85", cew: "#C74E96", usdcny: "#7B3FD0",
    brent: "#8E23C4", gold: "#B8860B",
    btc: "#6A0DFF",
  };

  /* Chart theme (light). */
  const AXIS_LINE = "#C9C9D2";
  const SPLIT = "rgba(17,17,26,.07)";
  const AXIS_TEXT = "#63636F";
  const TIP_BG = "#FFFFFF";
  const TIP_BORDER = "rgba(17,17,26,.14)";
  const TIP_TEXT = "#17171F";

  const state = {
    latest: null,
    maxDate: null,
    series: {},              // id -> {points, ...}
    seriesReady: false,
    charts: {},
    chartsBuilt: false,
    historyBuilt: false,
    range: { mode: "preset", days: 365, from: null, to: null },
    btcLog: false,
  };

  /* ---- safe DOM helper --------------------------------------------------- */
  function el(tag, opts = {}) {
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    if (opts.style) for (const [k, v] of Object.entries(opts.style)) node.style.setProperty(k, v);
    if (opts.children) for (const c of opts.children) if (c) node.appendChild(c);
    return node;
  }

  /* ---- formatting -------------------------------------------------------- */
  function fmt(v, d) {
    if (v == null || Number.isNaN(v)) return "–";
    return Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtSigned(v, d) {
    if (v == null || Number.isNaN(v)) return "–";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);
  }
  function fmtPct(v) {
    if (v == null || Number.isNaN(v)) return "–";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
  }
  function deltaClass(v) {
    if (v == null || Number.isNaN(v) || v === 0) return "delta--flat";
    return v > 0 ? "delta--up" : "delta--down";
  }
  function safeColor(c) { return HEX.test(c || "") ? c : "#63636F"; }
  function validDate(s) { return typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")); }
  function shiftDays(iso, n) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* ---- data load --------------------------------------------------------- */
  async function getJSON(path) {
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp.ok) throw new Error(`${resp.status} ${path}`);
    return resp.json();
  }
  async function getSeries(id) {
    if (state.series[id]) return state.series[id];
    const data = await getJSON(`${DATA}series/${id}.json`);
    state.series[id] = data;
    return data;
  }
  async function ensureSeries() {
    if (state.seriesReady) return;
    await Promise.all(state.latest.rows.map((r) => getSeries(r.id)));
    state.seriesReady = true;
  }

  /* ---- header + clock ---------------------------------------------------- */
  const slDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo", weekday: "long", day: "2-digit", month: "long", year: "numeric",
  });
  function tickClock() {
    const n = document.getElementById("sl-date");
    if (n) n.textContent = slDate.format(new Date());
  }
  function renderHeader(latest) {
    const r = document.getElementById("refreshed");
    if (r) r.textContent = `Last refreshed · ${latest.generated_slt} SLT`;
    const f = document.getElementById("footer-meta");
    if (f) f.textContent = `Build ${latest.generated_utc} · ${latest.rows.length} instruments`;
  }

  /* ---- board ------------------------------------------------------------- */
  function sparkline(values, color) {
    const NS = "http://www.w3.org/2000/svg";
    const w = 76, h = 24, pad = 2;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", w); svg.setAttribute("height", h);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("class", "spark"); svg.setAttribute("aria-hidden", "true");
    const nums = (values || []).filter((v) => typeof v === "number" && !Number.isNaN(v));
    if (nums.length < 2) return svg;
    const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
    const step = (w - pad * 2) / (nums.length - 1);
    const pts = nums.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`).join(" ");
    const line = document.createElementNS(NS, "polyline");
    line.setAttribute("points", pts);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", safeColor(color));
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    return svg;
  }
  function boardRow(row, index, reduceMotion) {
    const tick = el("span", { class: "name__tick", style: { "--tick": safeColor(row.color) } });
    const label = el("span", { class: "name__label", text: row.name });
    const meta = el("span", { class: "name__meta", text: row.last_date || "—" });
    if (row.note) { meta.classList.add("is-stale"); meta.title = row.note; meta.textContent = `${row.last_date || "—"} · stale`; }
    const nameCell = el("td", { children: [el("div", { class: "name", children: [tick, el("span", { class: "name__text", children: [label, meta] })] })] });
    const d = row.decimals;
    const tr = el("tr", { children: [
      nameCell,
      el("td", { class: "num val", text: fmt(row.today, d) }),
      el("td", { class: "num val val--prior", text: fmt(row.prior, d) }),
      el("td", { class: "num val val--twoday", text: fmt(row.twoday, d) }),
      el("td", { class: `num ${deltaClass(row.chg)}`, text: fmtSigned(row.chg, d) }),
      el("td", { class: `num ${deltaClass(row.chg_pct)}`, text: fmtPct(row.chg_pct) }),
      el("td", { class: `num ${deltaClass(row.twoday_chg_pct)}`, text: fmtPct(row.twoday_chg_pct) }),
      el("td", { class: "trend", children: [sparkline(row.spark, row.color)] }),
    ] });
    if (!reduceMotion) { tr.classList.add("row-enter"); tr.style.animationDelay = `${Math.min(index * 35, 350)}ms`; }
    return tr;
  }
  function renderBoard(latest) {
    const body = document.getElementById("ledger-body");
    if (!body) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frag = document.createDocumentFragment();
    [...latest.rows].sort((a, b) => a.order - b.order).forEach((row, i) => frag.appendChild(boardRow(row, i, reduceMotion)));
    body.replaceChildren(frag);
  }

  /* ---- as-of reconstruction (for snapshot downloads) --------------------- */
  function asOf(points, target) {
    const out = { today: null, prior: null, twoday: null, week: null, chg: null, chg_pct: null, twoday_chg_pct: null, week_chg_pct: null, last_date: null };
    let i = -1;
    for (let k = 0; k < points.length; k++) { if (points[k][0] <= target) i = k; else break; }
    if (i < 0) return out;
    const pct = (a, b) => (b ? Number((((a - b) / b) * 100).toFixed(4)) : null);
    out.today = points[i][1]; out.last_date = points[i][0];
    if (i >= 1) out.prior = points[i - 1][1];
    if (i >= 2) out.twoday = points[i - 2][1];
    const wkTarget = shiftDays(out.last_date, -7);
    for (let k = i - 1; k >= 0; k--) { if (points[k][0] <= wkTarget) { out.week = points[k][1]; break; } }
    if (out.prior != null) { out.chg = Number((out.today - out.prior).toFixed(6)); out.chg_pct = pct(out.today, out.prior); }
    if (out.twoday != null) out.twoday_chg_pct = pct(out.today, out.twoday);
    if (out.week != null) out.week_chg_pct = pct(out.today, out.week);
    return out;
  }

  /* ---- charts ------------------------------------------------------------ */
  function withinRange(points) {
    const r = state.range;
    if (r.mode === "custom") {
      return points.filter((p) => (!r.from || p[0] >= r.from) && (!r.to || p[0] <= r.to));
    }
    if (r.days === "all") return points;
    const last = points.length ? points[points.length - 1][0] : null;
    if (!last) return points;
    const cutoff = shiftDays(last, -Number(r.days));
    return points.filter((p) => p[0] >= cutoff);
  }
  function rebase(points) {
    if (!points.length) return [];
    const base = points[0][1] || 1;
    return points.map((p) => [p[0], (p[1] / base) * 100]);
  }
  function baseOption() {
    return {
      backgroundColor: "transparent",
      grid: { left: 52, right: 52, top: 34, bottom: 28 },
      textStyle: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: AXIS_TEXT },
      tooltip: { trigger: "axis", backgroundColor: TIP_BG, borderColor: TIP_BORDER, borderWidth: 1, textStyle: { color: TIP_TEXT, fontSize: 12 } },
      legend: { top: 2, right: 8, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: AXIS_TEXT, fontSize: 11 } },
      xAxis: { type: "time", axisLine: { lineStyle: { color: AXIS_LINE } }, axisLabel: { color: AXIS_TEXT, fontSize: 10, hideOverlap: true }, splitLine: { show: false } },
    };
  }
  /* scale:true makes the y-axis auto-fit the visible data (never fixed, never
     forced through zero), so it recalibrates whenever the range changes. */
  function yAxis(extra = {}) {
    return Object.assign({ type: "value", scale: true, axisLabel: { color: AXIS_TEXT, fontSize: 10 }, splitLine: { lineStyle: { color: SPLIT } } }, extra);
  }
  function lineSeries(name, id, points, opts = {}) {
    return Object.assign({
      name, type: "line", showSymbol: false, smooth: opts.smooth ?? 0.15,
      lineStyle: { width: 2, color: LINE[id] }, itemStyle: { color: LINE[id] },
      emphasis: { focus: "series" }, data: points.map((p) => [p[0], p[1]]),
    }, opts.series || {});
  }
  function ensureChart(elId) {
    if (state.charts[elId]) return state.charts[elId];
    const node = document.getElementById(elId);
    if (!node || !window.echarts) return null;
    const c = window.echarts.init(node, null, { renderer: "canvas" });
    state.charts[elId] = c;
    return c;
  }
  async function drawEquities() {
    const c = ensureChart("chart-equities"); if (!c) return;
    const data = await Promise.all(["dow_jones", "sp500", "nasdaq"].map(getSeries));
    const opt = baseOption();
    opt.yAxis = yAxis();
    opt.series = data.map((s) => lineSeries(s.name.replace(" Composite", ""), s.id, rebase(withinRange(s.points))));
    c.setOption(opt, true);
  }
  async function drawRates() {
    const c = ensureChart("chart-rates"); if (!c) return;
    const s = await getSeries("us10y");
    const opt = baseOption();
    opt.legend = { show: false }; opt.grid.right = 40;
    opt.yAxis = yAxis({ axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "{value}%" } });
    opt.series = [lineSeries("US 10Y", "us10y", withinRange(s.points), { series: { areaStyle: { color: "rgba(219,75,69,.12)" } } })];
    c.setOption(opt, true);
  }
  async function drawEM() {
    const c = ensureChart("chart-em"); if (!c) return;
    const data = await Promise.all(["eem", "cew", "usdcny"].map(getSeries));
    const opt = baseOption();
    opt.yAxis = yAxis();
    opt.series = data.map((s) => lineSeries(s.name.replace(/\s*\(.*\)/, ""), s.id, rebase(withinRange(s.points))));
    c.setOption(opt, true);
  }
  async function drawCommodities() {
    const c = ensureChart("chart-commodities"); if (!c) return;
    const [brent, gold] = await Promise.all([getSeries("brent"), getSeries("gold")]);
    const opt = baseOption();
    opt.yAxis = [
      yAxis({ name: "Brent", nameTextStyle: { color: LINE.brent, fontSize: 10 }, position: "left", axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "${value}" } }),
      yAxis({ name: "Gold", nameTextStyle: { color: LINE.gold, fontSize: 10 }, position: "right", splitLine: { show: false }, axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "${value}" } }),
    ];
    opt.series = [
      lineSeries("Brent", "brent", withinRange(brent.points), { series: { yAxisIndex: 0 } }),
      lineSeries("Gold", "gold", withinRange(gold.points), { series: { yAxisIndex: 1 } }),
    ];
    c.setOption(opt, true);
  }
  async function drawCrypto() {
    const c = ensureChart("chart-crypto"); if (!c) return;
    const s = await getSeries("btc");
    const opt = baseOption();
    opt.legend = { show: false };
    opt.yAxis = yAxis({ type: state.btcLog ? "log" : "value", axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: (v) => "$" + Number(v).toLocaleString("en-US") } });
    opt.series = [lineSeries("BTC", "btc", withinRange(s.points), { series: { areaStyle: { color: "rgba(106,13,255,.10)" } } })];
    c.setOption(opt, true);
  }
  async function drawAll() {
    if (!window.echarts) {
      document.querySelectorAll(".chart").forEach((n) => n.replaceChildren(el("div", { class: "chart__empty", text: "Charts appear after the first data refresh vendors the chart library (see README)." })));
      return;
    }
    await ensureSeries();
    await Promise.all([drawEquities(), drawRates(), drawEM(), drawCommodities(), drawCrypto()]);
  }

  /* ---- historical browse ------------------------------------------------- */
  function chgSeries(points) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const [date, close] = points[i];
      const prev = i > 0 ? points[i - 1][1] : null;
      const chg = prev != null ? close - prev : null;
      const pct = prev ? (chg / prev) * 100 : null;
      out.push({ date, close, chg, pct });
    }
    return out;
  }
  async function renderHistory() {
    const sel = document.getElementById("hist-instrument");
    const body = document.getElementById("hist-body");
    if (!sel || !body) return;
    const row = state.latest.rows.find((r) => r.id === sel.value) || state.latest.rows[0];
    const s = await getSeries(row.id);
    const from = document.getElementById("hist-from").value;
    const to = document.getElementById("hist-to").value;
    const f = validDate(from) ? from : null;
    const t = validDate(to) ? to : null;
    const all = chgSeries(s.points).filter((r) => (!f || r.date >= f) && (!t || r.date <= t));
    all.reverse(); // newest first
    const d = row.decimals;
    const frag = document.createDocumentFragment();
    for (const r of all) {
      frag.appendChild(el("tr", { children: [
        el("td", { text: r.date }),
        el("td", { class: "num val", text: fmt(r.close, d) }),
        el("td", { class: `num ${deltaClass(r.chg)}`, text: fmtSigned(r.chg, d) }),
        el("td", { class: `num ${deltaClass(r.pct)}`, text: fmtPct(r.pct) }),
      ] }));
    }
    body.replaceChildren(frag);
  }
  function buildHistoryOnce() {
    if (state.historyBuilt) return;
    const sel = document.getElementById("hist-instrument");
    const frag = document.createDocumentFragment();
    [...state.latest.rows].sort((a, b) => a.order - b.order).forEach((r) => frag.appendChild(el("option", { text: r.name, attrs: { value: r.id } })));
    sel.replaceChildren(frag);
    const to = document.getElementById("hist-to");
    const from = document.getElementById("hist-from");
    if (state.maxDate) { to.value = state.maxDate; to.max = state.maxDate; from.max = state.maxDate; from.value = shiftDays(state.maxDate, -90); }
    state.historyBuilt = true;
  }

  /* ---- snapshot downloads ------------------------------------------------ */
  function snapshotRows(target) {
    const header = ["Instrument", "Today Close", "Prior Close", "2-Day Prior", "Chg ($)", "Chg (%)", "2D Chg (%)", "1W Ago", "1W Chg (%)", "As-Of Date"];
    const round = (v, d) => (v == null || Number.isNaN(v) ? "" : Number(Number(v).toFixed(d)));
    const rows = [...state.latest.rows].sort((a, b) => a.order - b.order).map((r) => {
      const s = state.series[r.id];
      const m = s ? asOf(s.points, target) : {};
      return [r.name, round(m.today, r.decimals), round(m.prior, r.decimals), round(m.twoday, r.decimals),
        round(m.chg, r.decimals), round(m.chg_pct, 2), round(m.twoday_chg_pct, 2),
        round(m.week, r.decimals), round(m.week_chg_pct, 2), m.last_date || ""];
    });
    return { header, rows };
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { attrs: { href: url, download: filename } });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function snapTarget() {
    const v = document.getElementById("snap-date").value;
    return validDate(v) ? v : (state.maxDate || new Date().toISOString().slice(0, 10));
  }
  async function downloadCSV() {
    await ensureSeries();
    const target = snapTarget();
    const { header, rows } = snapshotRows(target);
    const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `frontier-global-daily-${target}.csv`);
  }
  async function downloadXLSX() {
    await ensureSeries();
    if (!window.XLSX) { setHint("Excel export needs the vendored library — run the data refresh once, then reload."); return; }
    const target = snapTarget();
    const { header, rows } = snapshotRows(target);
    const ws = window.XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Snapshot");
    window.XLSX.writeFile(wb, `frontier-global-daily-${target}.xlsx`);
  }
  function setHint(msg) { const n = document.getElementById("snap-hint"); if (n) n.textContent = msg; }

  /* ---- tabs -------------------------------------------------------------- */
  function activateTab(tab) {
    const tabs = [...document.querySelectorAll(".tab")];
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    if (tab.id === "tab-charts") {
      if (!state.chartsBuilt) { state.chartsBuilt = true; drawAll(); }
      else setTimeout(() => Object.values(state.charts).forEach((c) => c.resize()), 60);
    } else if (tab.id === "tab-historical") {
      buildHistoryOnce();
      ensureSeries().then(renderHistory);
    }
  }
  function wireTabs() {
    const tabs = [...document.querySelectorAll(".tab")];
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => activateTab(t));
      t.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); activateTab(next);
      });
    });
  }

  /* ---- controls ---------------------------------------------------------- */
  function clearPresetActive() { document.querySelectorAll(".range__btn").forEach((b) => b.classList.remove("is-active")); }
  function wireControls() {
    document.querySelectorAll(".range__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        clearPresetActive(); btn.classList.add("is-active");
        const v = btn.getAttribute("data-range");
        state.range = { mode: "preset", days: v === "all" ? "all" : Number(v), from: null, to: null };
        document.getElementById("chart-from").value = ""; document.getElementById("chart-to").value = "";
        drawAll();
      });
    });
    const cf = document.getElementById("chart-from"), ct = document.getElementById("chart-to");
    function customChanged() {
      const from = validDate(cf.value) ? cf.value : null;
      const to = validDate(ct.value) ? ct.value : null;
      if (!from && !to) return;
      clearPresetActive();
      state.range = { mode: "custom", days: null, from, to };
      drawAll();
    }
    if (cf) { cf.addEventListener("change", customChanged); if (state.maxDate) cf.max = state.maxDate; }
    if (ct) { ct.addEventListener("change", customChanged); if (state.maxDate) ct.max = state.maxDate; }
    const reset = document.getElementById("chart-reset");
    if (reset) reset.addEventListener("click", () => {
      cf.value = ""; ct.value = "";
      clearPresetActive();
      const oneY = document.querySelector('.range__btn[data-range="365"]');
      if (oneY) oneY.classList.add("is-active");
      state.range = { mode: "preset", days: 365, from: null, to: null };
      drawAll();
    });

    const log = document.getElementById("btc-log");
    if (log) log.addEventListener("change", () => { state.btcLog = log.checked; drawCrypto(); });

    document.getElementById("dl-csv").addEventListener("click", downloadCSV);
    document.getElementById("dl-xlsx").addEventListener("click", downloadXLSX);
    const snap = document.getElementById("snap-date");
    if (snap) snap.addEventListener("change", () => { const t = snapTarget(); setHint(`Snapshot as of ${t}. The nearest earlier close is used where a market was closed.`); });

    ["hist-instrument", "hist-from", "hist-to"].forEach((id) => {
      const n = document.getElementById(id);
      if (n) n.addEventListener("change", renderHistory);
    });

    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => Object.values(state.charts).forEach((c) => c.resize()), 120); });
  }

  /* ---- boot -------------------------------------------------------------- */
  function initDates() {
    state.maxDate = state.latest.rows.reduce((m, r) => (r.last_date && (!m || r.last_date > m) ? r.last_date : m), null);
    const snap = document.getElementById("snap-date");
    if (snap && state.maxDate) { snap.value = state.maxDate; snap.max = state.maxDate; }
    if (state.maxDate) setHint(`Snapshot as of ${state.maxDate}. Pick any earlier date to export the board as it stood then.`);
  }
  async function init() {
    tickClock(); setInterval(tickClock, 60000);
    wireTabs();
    try {
      state.latest = await getJSON(`${DATA}latest.json`);
      renderHeader(state.latest);
      renderBoard(state.latest);
      initDates();
      wireControls();
    } catch (err) {
      const r = document.getElementById("refreshed");
      if (r) r.textContent = "No data yet — the first scheduled refresh will populate the board.";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
