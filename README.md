# Frontier Global Daily — Tracker

A static, GitHub Pages–hosted dashboard that tracks ten global instruments end-of-day,
keeps a growing Excel history, and lets you download the latest board as CSV or Excel.

Sources are all free: **FRED** (rates, USD/CNY, Brent), **Stooq** (equity indices,
EEM, CEW, gold), **CoinGecko** (Bitcoin).

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

| Instrument | Source | Symbol |
|---|---|---|
| Dow Jones | Stooq | `^dji` |
| S&P 500 | Stooq | `^spx` |
| NASDAQ Composite | Stooq | `^ndq` |
| US 10Y Treasury Yield | FRED | `DGS10` |
| MSCI EM Index (EEM) | Stooq | `eem.us` |
| MSCI EM Ccy Idx (CEW) | Stooq | `cew.us` |
| USD/CNY | FRED | `DEXCHUS` |
| Brent Crude Oil | FRED | `DCOILBRENTEU` |
| Spot Gold (XAU) | Stooq | `xauusd` |
| Bitcoin (BTC/USD) | CoinGecko | `bitcoin` |

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
5. (Optional) Add a `COINGECKO_API_KEY` repo secret to raise CoinGecko's rate limit — not
   required for twice-a-day polling.

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
- **No secrets in the browser**: FRED uses the keyless CSV export; the only optional
  secret (CoinGecko key) lives in Actions, never in the page.
- **Resilient fetching**: HTTPS with cert verification on, bounded timeouts, retry with
  backoff, value sanity-checks, and atomic writes so a bad run can't corrupt the store.
- **Least-privilege CI**: the workflow only has `contents: write`; actions are pinned.
- `frame-ancestors` can't be set via a `<meta>` tag; GitHub Pages doesn't allow custom
  headers, so clickjacking protection there would need a proxy (Cloudflare) if required.

## To Note for me - Verify on first real run
Because I couldn't hit the network while building this, confirm these once:
`^ndq` is the NASDAQ **Composite** on Stooq (not the 100), `xauusd` returns gold spot,
`DEXCHUS` is CNY-per-USD, and `^tnx`-style yield scaling isn't an issue (FRED `DGS10` is
already a clean percent). If a symbol is off, fix the one line in `scripts/sources.py`.
