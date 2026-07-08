/* ============================================================================
   Frontier Global Daily — Tracker
   Reads only same-origin JSON that the GitHub Action committed. Every value that
   reaches the DOM goes in through textContent or a validated attribute — never
   innerHTML — so there is no HTML-injection surface even if a feed were tampered.
   ========================================================================== */
"use strict";

(function () {
  const DATA = "data/";
  const HEX = /^#[0-9a-fA-F]{6}$/;

  // Line colours chosen for legibility *within* a panel, kept in each group's
  // colour family. Board row ticks use the group colour from the data itself.
  const LINE = {
    dow_jones: "#FF6A00", sp500: "#F5B833", nasdaq: "#FF9147",
    us10y: "#DB4B45",
    eem: "#B23A85", cew: "#E06AB0", usdcny: "#8E5BD0",
    brent: "#8E23C4", gold: "#E8C15A",
    btc: "#8B5CFF",
  };

  const AXIS_LINE = "#3A3A47";
  const SPLIT = "rgba(255,255,255,.05)";
  const AXIS_TEXT = "#8A8A9A";

  const state = {
    latest: null,
    rangeDays: 365,       // matches the "1Y" default active button
    btcLog: false,
    series: {},           // id -> {points, ...}
    charts: {},           // panel id -> echarts instance
  };

  /* ---- tiny safe DOM helper --------------------------------------------- */
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
  function fmt(value, decimals) {
    if (value == null || Number.isNaN(value)) return "–";
    return Number(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
  }
  function fmtSigned(value, decimals) {
    if (value == null || Number.isNaN(value)) return "–";
    const s = fmt(Math.abs(value), decimals);
    return (value > 0 ? "+" : value < 0 ? "−" : "") + s;
  }
  function fmtPct(value) {
    if (value == null || Number.isNaN(value)) return "–";
    const s = Math.abs(value).toFixed(2) + "%";
    return (value > 0 ? "+" : value < 0 ? "−" : "") + s;
  }
  function deltaClass(value) {
    if (value == null || Number.isNaN(value) || value === 0) return "delta--flat";
    return value > 0 ? "delta--up" : "delta--down";
  }
  function safeColor(c) { return HEX.test(c || "") ? c : "#8A8A9A"; }

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

  /* ---- header + clock ---------------------------------------------------- */
  const slDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo", weekday: "long", day: "2-digit", month: "long", year: "numeric",
  });
  function tickClock() {
    const node = document.getElementById("sl-date");
    if (node) node.textContent = slDate.format(new Date());
  }

  function renderHeader(latest) {
    const r = document.getElementById("refreshed");
    if (r) r.textContent = `Last refreshed · ${latest.generated_slt} SLT`;
    const f = document.getElementById("footer-meta");
    if (f) f.textContent = `Build ${latest.generated_utc} · ${latest.rows.length} instruments`;
  }

  /* ---- board table ------------------------------------------------------- */
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
    const pts = nums.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
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
    const nameCell = el("td", { children: [
      el("div", { class: "name", children: [tick, el("span", { class: "name__text", children: [label, meta] })] }),
    ] });

    const d = row.decimals;
    const cells = [
      nameCell,
      el("td", { class: "num val", text: fmt(row.today, d) }),
      el("td", { class: "num val val--prior", text: fmt(row.prior, d) }),
      el("td", { class: "num val val--twoday", text: fmt(row.twoday, d) }),
      el("td", { class: `num ${deltaClass(row.chg)}`, text: fmtSigned(row.chg, d) }),
      el("td", { class: `num ${deltaClass(row.chg_pct)}`, text: fmtPct(row.chg_pct) }),
      el("td", { class: `num ${deltaClass(row.twoday_chg_pct)}`, text: fmtPct(row.twoday_chg_pct) }),
      el("td", { class: "trend", children: [sparkline(row.spark, row.color)] }),
    ];
    const tr = el("tr", { children: cells });
    if (!reduceMotion) { tr.classList.add("row-enter"); tr.style.animationDelay = `${Math.min(index * 35, 350)}ms`; }
    return tr;
  }

  function renderBoard(latest) {
    const body = document.getElementById("ledger-body");
    if (!body) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rows = [...latest.rows].sort((a, b) => a.order - b.order);
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => frag.appendChild(boardRow(row, i, reduceMotion)));
    body.replaceChildren(frag);
  }

  /* ---- charts ------------------------------------------------------------ */
  function withinRange(points) {
    if (state.rangeDays === "all") return points;
    const last = points.length ? points[points.length - 1][0] : null;
    if (!last) return points;
    const cutoff = new Date(last + "T00:00:00Z");
    cutoff.setUTCDate(cutoff.getUTCDate() - Number(state.rangeDays));
    const iso = cutoff.toISOString().slice(0, 10);
    return points.filter((p) => p[0] >= iso);
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
      tooltip: {
        trigger: "axis",
        backgroundColor: "#13131C", borderColor: "rgba(255,255,255,.12)",
        textStyle: { color: "#ECECF2", fontSize: 12 },
      },
      legend: {
        top: 2, right: 8, icon: "roundRect", itemWidth: 10, itemHeight: 10,
        textStyle: { color: AXIS_TEXT, fontSize: 11 },
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: AXIS_LINE } },
        axisLabel: { color: AXIS_TEXT, fontSize: 10, hideOverlap: true },
        splitLine: { show: false },
      },
    };
  }
  function yAxis(extra = {}) {
    return Object.assign({
      type: "value", scale: true,
      axisLabel: { color: AXIS_TEXT, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT } },
    }, extra);
  }
  function lineSeries(name, id, points, opts = {}) {
    return Object.assign({
      name, type: "line", showSymbol: false, smooth: opts.smooth ?? 0.15,
      lineStyle: { width: 2, color: LINE[id] }, itemStyle: { color: LINE[id] },
      emphasis: { focus: "series" },
      data: points.map((p) => [p[0], p[1]]),
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
    const ids = ["dow_jones", "sp500", "nasdaq"];
    const data = await Promise.all(ids.map(getSeries));
    const opt = baseOption();
    opt.yAxis = yAxis({ axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "{value}" } });
    opt.series = data.map((s) => lineSeries(s.name.replace(" Composite", ""), s.id, rebase(withinRange(s.points))));
    c.setOption(opt, true);
  }

  async function drawRates() {
    const c = ensureChart("chart-rates"); if (!c) return;
    const s = await getSeries("us10y");
    const pts = withinRange(s.points);
    const opt = baseOption();
    opt.legend = { show: false };
    opt.grid.right = 40;
    opt.yAxis = yAxis({ axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "{value}%" } });
    opt.series = [lineSeries("US 10Y", "us10y", pts, {
      series: { areaStyle: { color: "rgba(219,75,69,.16)" } },
    })];
    c.setOption(opt, true);
  }

  async function drawEM() {
    const c = ensureChart("chart-em"); if (!c) return;
    const ids = ["eem", "cew", "usdcny"];
    const data = await Promise.all(ids.map(getSeries));
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
      yAxis({ name: "Brent", nameTextStyle: { color: LINE.brent, fontSize: 10 }, position: "left",
        axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "${value}" } }),
      yAxis({ name: "Gold", nameTextStyle: { color: LINE.gold, fontSize: 10 }, position: "right",
        splitLine: { show: false }, axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: "${value}" } }),
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
    opt.yAxis = yAxis({
      type: state.btcLog ? "log" : "value",
      axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: (v) => "$" + Number(v).toLocaleString("en-US") },
    });
    opt.series = [lineSeries("BTC", "btc", withinRange(s.points), {
      series: { areaStyle: { color: "rgba(139,92,255,.12)" } },
    })];
    c.setOption(opt, true);
  }

  async function drawAll() {
    if (!window.echarts) {
      document.querySelectorAll(".chart").forEach((n) => {
        n.replaceChildren(el("div", { class: "chart__empty",
          text: "Charts load once the data refresh has vendored the chart library." }));
      });
      return;
    }
    await Promise.all([drawEquities(), drawRates(), drawEM(), drawCommodities(), drawCrypto()]);
  }

  /* ---- downloads --------------------------------------------------------- */
  function exportRows(latest) {
    const header = ["Instrument", "Today Close", "Prior Close", "2-Day Prior",
      "Chg ($)", "Chg (%)", "2D Chg (%)", "1W Ago", "1W Chg (%)", "Last Updated"];
    const round = (v, d) => (v == null || Number.isNaN(v) ? "" : Number(Number(v).toFixed(d)));
    const rows = [...latest.rows].sort((a, b) => a.order - b.order).map((r) => [
      r.name, round(r.today, r.decimals), round(r.prior, r.decimals), round(r.twoday, r.decimals),
      round(r.chg, r.decimals), round(r.chg_pct, 2), round(r.twoday_chg_pct, 2),
      round(r.week, r.decimals), round(r.week_chg_pct, 2), r.last_date || "",
    ]);
    return { header, rows };
  }
  function stamp() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { attrs: { href: url, download: filename } });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadCSV() {
    if (!state.latest) return;
    const { header, rows } = exportRows(state.latest);
    const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `frontier-global-daily-${stamp()}.csv`);
  }
  function downloadXLSX() {
    if (!state.latest) return;
    if (!window.XLSX) { alertMissing(); return; }
    const { header, rows } = exportRows(state.latest);
    const ws = window.XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Latest");
    window.XLSX.writeFile(wb, `frontier-global-daily-${stamp()}.xlsx`);
  }
  function alertMissing() {
    const f = document.getElementById("footer-meta");
    if (f) f.textContent = "Excel export needs the vendored library — run the data refresh once, then reload.";
  }

  /* ---- wiring ------------------------------------------------------------ */
  function wireControls() {
    document.querySelectorAll(".range__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".range__btn").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const v = btn.getAttribute("data-range");
        state.rangeDays = v === "all" ? "all" : Number(v);
        drawAll();
      });
    });
    const log = document.getElementById("btc-log");
    if (log) log.addEventListener("change", () => { state.btcLog = log.checked; drawCrypto(); });
    const csv = document.getElementById("dl-csv");
    if (csv) csv.addEventListener("click", downloadCSV);
    const xlsx = document.getElementById("dl-xlsx");
    if (xlsx) xlsx.addEventListener("click", downloadXLSX);

    let t;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(() => Object.values(state.charts).forEach((c) => c.resize()), 120);
    });
  }

  /* ---- boot -------------------------------------------------------------- */
  async function init() {
    tickClock();
    setInterval(tickClock, 60000);
    wireControls();
    try {
      const latest = await getJSON(`${DATA}latest.json`);
      state.latest = latest;
      renderHeader(latest);
      renderBoard(latest);
      await drawAll();
    } catch (err) {
      const r = document.getElementById("refreshed");
      if (r) r.textContent = "No data yet — the first scheduled refresh will populate the board.";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
