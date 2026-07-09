# Frontier Global Daily — Tracker

A static, GitHub Pages–hosted dashboard that tracks ten global instruments end-of-day,
keeps a growing Excel history, and lets you download the latest board as CSV or Excel.

Primary source is **Twelve Data** (free Basic plan). **Brent stays on FRED** because
Twelve Data gates commodities behind its paid tier. Every Twelve-Data instrument also
has a fallback source that fires only if the free tier is unavailable for that symbol.

---

## How it fits together

The page itself never fetches from data providers. GitHub Pages only serves static
files, and a browser can't call these endpoints anyway. So the work is split:

```
GitHub Actions (twice a day)            GitHub Pages (static)
────────────────────────────           ─────────────────────
scripts/fetch.py                        index.html
  ├─ pull each instrument       ┐       assets/app.js  ── reads ──┐
  ├─ merge into store.xlsx      │ commits                          │
  ├─ derive today/prior/…       ├───────►  data/latest.json  ◄─────┤
  └─ write JSON sidecars        │          data/series/*.json      │
                                ┘          data/meta.json          │
                                           data/store.xlsx (download)
```

The Action fetches and commits data back to the repo; the page just reads those
committed files. Same origin, so there is no CORS problem and no secret in the browser.

## The instruments

| Instrument | Primary (Twelve Data) | Fallback |
|---|---|---|
| Dow Jones | `DJI` | Stooq `^dji` |
| S&P 500 | `SPX` | Stooq `^spx` |
| NASDAQ Composite | `IXIC` | Stooq `^ndq` |
| US 10Y Treasury Yield | `US10Y` | FRED `DGS10` |
| MSCI EM Index (EEM) | `EEM` | Stooq `eem.us` |
| MSCI EM Ccy Idx (CEW) | `CEW` | Stooq `cew.us` |
| USD/CNY | `USD/CNY` | FRED `DEXCHUS` |
| Brent Crude Oil | FRED `DCOILBRENTEU` *(primary — not on TD free)* | — |
| Spot Gold (XAU) | `XAU/USD` | Stooq `xauusd` |
| Bitcoin (BTC/USD) | `BTC/USD` | CoinGecko `bitcoin` |

Twelve Data free tier: 8 API credits/min, 800/day. The pipeline throttles to ≤7/min,
so a run takes ~1–2 minutes. The free tier is licensed for personal/non-commercial use —
check this fits your use before relying on it for work reporting.

Everything is defined in one place — `scripts/sources.py`. The front end reads the
group, colour, unit and precision straight from the data, so adding or re-pointing an
instrument is a one-line change there and nothing downstream needs editing.

## The interface

Three tabs: **Board** (the live snapshot), **Historical data** (download any past
date's board as CSV/Excel, plus a per-instrument daily-history browser with a date
range), and **Charts** (the five panels with quick ranges *and* a custom From/To range;
the y-axis auto-calibrates to whatever window is shown). All of this runs off the same
committed JSON — no extra pipeline output is needed.

## Refresh schedule (Sri Lanka time)

Two runs a day, set in `.github/workflows/update-data.yml`:

| Cron (UTC) | Sri Lanka | Purpose |
|---|---|---|
| `30 0 * * *` | ~06:00 SLT | **Report run.** US close has settled + overnight crypto/FX/commodities captured, so the board is ready ahead of a 07:00 SLT report. |
| `0 13 * * *` | ~18:30 SLT | Sri Lankan evening, before the next US open. Captures the day's crypto / FX / commodity drift. |

For a **daily** series this is ample: each run pulls the full daily history and
upserts by date, so history builds itself — one run after the US close would already
be enough. The second run mainly adds a fresh evening snapshot for the 24/7 markets and
gives redundancy if a run is delayed. (US close moves between 20:00–21:00 UTC across
daylight saving; the 02:00 UTC slot has buffer for both, plus for Stooq's EOD file to post.)

## Append-only, holiday-aware

On each run, per instrument: new dates are appended; the most recent stored date may be
refreshed (provisional → final, or an intraday move); if the source has nothing newer —
a weekend or market holiday — nothing is appended and the row is flagged `stale` with the
last trading day. No hard-coded holiday calendar is needed: a non-trading day simply
returns no new date. A failed fetch keeps the stored history untouched.

## Setup

1. Create a repo, drop these files in at the root, and push.
2. **Settings → Pages** → deploy from branch (root).
3. **Settings → Actions → General** → allow workflows to write (Read and write permissions).
4. **Actions** tab → run *Update market data* once via *Run workflow* to replace the
   bundled sample data with real data and vendor the chart libraries.
5. **Add your Twelve Data key** as a repo secret named `TWELVE_DATA_API_KEY`
   (Settings → Secrets and variables → Actions). Create a free Basic key at
   twelvedata.com. Without it, every instrument falls back to its secondary source.
6. (Optional) Add a `COINGECKO_API_KEY` secret — only used if Bitcoin falls back to
   CoinGecko. Not required for normal operation.

### Preview locally
```bash
pip install -r scripts/requirements.txt
python scripts/seed_sample.py          # writes sample data (or run fetch.py for real)
# fetch the two vendored libs once (see assets/vendor/README.md), then:
python -m http.server 8000             # open http://localhost:8000
```

## Security

- **Strict CSP** (`index.html`): `default-src 'none'`, everything else `'self'`. No inline
  scripts, no inline styles, no `eval`, no third-party hosts. ECharts and SheetJS are
  vendored locally so `script-src 'self'` holds.
- **No injection surface**: every value that reaches the DOM goes through `textContent`
  or a validated attribute (colours are regex-checked hex) — never `innerHTML`.
- **No secrets in the browser**: the Twelve Data key lives only in an Actions secret,
  never in code, committed files, or the page. Twelve Data accepts the key only as a URL
  parameter, so it is redacted from every error/log string (on top of Actions' own secret
  masking). FRED (Brent) is keyless.
- **Resilient fetching**: HTTPS with cert verification on, bounded timeouts, retry with
  backoff, value sanity-checks, and atomic writes so a bad run can't corrupt the store.
- **Least-privilege CI**: the workflow only has `contents: write`; actions are pinned.
- `frame-ancestors` can't be set via a `<meta>` tag; GitHub Pages doesn't allow custom
  headers, so clickjacking protection there would need a proxy (Cloudflare) if required.

## Verify on first real run
Because I couldn't hit the network while building this, confirm these once:
`^ndq` is the NASDAQ **Composite** on Stooq (not the 100), `xauusd` returns gold spot,
`DEXCHUS` is CNY-per-USD, and `^tnx`-style yield scaling isn't an issue (FRED `DGS10` is
already a clean percent). If a symbol is off, fix the one line in `scripts/sources.py`.
