"""
sources.py — single source of truth for what we track and where it comes from.

Primary source is now Twelve Data (free "Basic" plan). Each instrument may declare
a fallback source that is used ONLY if the primary call fails or the free tier
rejects the symbol, so a single gap never breaks the 6 AM report run.

Notes on Twelve Data's free tier (verified against their docs/pricing):
  * 8 API credits/minute, 800/day. One /time_series symbol = 1 credit. We throttle
    to <=7/min, so a full run takes ~1-2 minutes.
  * Covers US equities, forex, crypto, and US Treasury yields on Basic.
  * Commodities (Brent) require the paid Grow plan, so Brent stays on FRED (keyless).
  * Indices/ETFs should be Basic ("all US markets"); if a given key rejects one,
    its Stooq fallback fires automatically.

Security:
  * The API key is read from the TWELVE_DATA_API_KEY environment variable only —
    never hard-coded, never written to any committed file, never sent to the browser.
  * Twelve Data accepts the key only as a URL parameter, so the key is redacted from
    every error/log string this module can produce (defence in depth on top of
    GitHub Actions' own secret masking).
  * HTTPS with cert verification, bounded timeouts, retry-with-backoff, and value
    range-checks before anything enters the store.
"""

from __future__ import annotations

import csv
import io
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, List, Tuple

import requests

Point = Tuple[str, float]

_TIMEOUT = 30
_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "frontier-global-daily/1.0 (+github-pages static tracker)"})


# --------------------------------------------------------------------------- #
# HTTP helper (with key redaction)                                            #
# --------------------------------------------------------------------------- #
def _get(url: str, *, headers: dict | None = None, params: dict | None = None,
         retries: int = 3, redact: str | None = None) -> requests.Response:
    """GET with bounded timeout + backoff. If `redact` is given, that substring is
    scrubbed from any error text so an API key can never leak into logs."""
    def scrub(x) -> str:
        s = str(x)
        return s.replace(redact, "***") if redact else s

    last_exc = None
    for attempt in range(retries):
        try:
            resp = _SESSION.get(url, headers=headers, params=params, timeout=_TIMEOUT)
            if resp.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {resp.status_code}")  # no URL -> no key
            resp.raise_for_status()
            return resp
        except Exception as exc:  # noqa: BLE001
            last_exc = scrub(exc)
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(scrub(f"request failed after {retries} attempts: {last_exc}"))


def _safe_float(raw: str) -> float | None:
    raw = (raw or "").strip()
    if raw in ("", ".", "N/D", "null", "NaN"):
        return None
    try:
        val = float(raw)
    except ValueError:
        return None
    if val != val or abs(val) > 1e12:
        return None
    return val


def _dedupe_sorted(points: List[Point]) -> List[Point]:
    by_date: dict[str, float] = {}
    for d, v in points:
        by_date[d] = v
    return [(d, by_date[d]) for d in sorted(by_date)]


# --------------------------------------------------------------------------- #
# Twelve Data (primary) — with a simple per-minute rate limiter               #
# --------------------------------------------------------------------------- #
TD_BASE = "https://api.twelvedata.com/time_series"
_TD_CALLS: list[float] = []
_TD_MAX_PER_MIN = 7  # stay safely under the free tier's 8/min

def _td_throttle() -> None:
    now = time.monotonic()
    global _TD_CALLS
    _TD_CALLS = [t for t in _TD_CALLS if now - t < 60]
    if len(_TD_CALLS) >= _TD_MAX_PER_MIN:
        sleep_for = 60 - (now - _TD_CALLS[0]) + 0.5
        if sleep_for > 0:
            time.sleep(sleep_for)
        now = time.monotonic()
        _TD_CALLS = [t for t in _TD_CALLS if now - t < 60]
    _TD_CALLS.append(time.monotonic())


def fetch_twelvedata(symbol: str) -> List[Point]:
    key = os.environ.get("TWELVE_DATA_API_KEY", "").strip()
    if not key:
        raise RuntimeError("TWELVE_DATA_API_KEY not set")
    _td_throttle()
    params = {"symbol": symbol, "interval": "1day", "outputsize": 5000,
              "order": "ASC", "format": "JSON", "apikey": key}
    data = _get(TD_BASE, params=params, redact=key).json()
    if isinstance(data, dict) and data.get("status") == "error":
        code = data.get("code")
        msg = str(data.get("message", ""))[:140].replace(key, "***")
        raise RuntimeError(f"twelvedata error {code}: {msg}")
    values = data.get("values") if isinstance(data, dict) else None
    if not values:
        raise RuntimeError(f"twelvedata: no values for '{symbol}'")
    out: List[Point] = []
    for row in values:
        date = str(row.get("datetime", ""))[:10]
        close = _safe_float(str(row.get("close", "")))
        if date and close is not None:
            out.append((date, close))
    if not out:
        raise RuntimeError(f"twelvedata: no usable rows for '{symbol}'")
    return _dedupe_sorted(out)


# --------------------------------------------------------------------------- #
# Fallback adapters (used only if Twelve Data is unavailable for a symbol)     #
# --------------------------------------------------------------------------- #
def fetch_stooq(symbol: str) -> List[Point]:
    url = f"https://stooq.com/q/d/l/?s={symbol.lower()}&i=d"
    text = _get(url).text
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or "Close" not in reader.fieldnames:
        raise RuntimeError(f"stooq: unexpected response for '{symbol}': {text[:80]!r}")
    out: List[Point] = []
    for row in reader:
        date = (row.get("Date") or "").strip()
        close = _safe_float(row.get("Close", ""))
        if date and close is not None:
            out.append((date, close))
    if not out:
        raise RuntimeError(f"stooq: no usable rows for '{symbol}'")
    return _dedupe_sorted(out)


def fetch_fred(series_id: str) -> List[Point]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    text = _get(url).text
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        raise RuntimeError(f"fred: empty response for '{series_id}'")
    out: List[Point] = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        date, value = row[0].strip(), _safe_float(row[1])
        if date and value is not None:
            out.append((date, value))
    if not out:
        raise RuntimeError(f"fred: no usable rows for '{series_id}'")
    return _dedupe_sorted(out)


def fetch_coingecko(coin_id: str, days: int | None = None) -> List[Point]:
    days = days or int(os.environ.get("COINGECKO_DAYS", "365"))
    url = (f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
           f"?vs_currency=usd&days={days}")
    headers = {}
    api_key = os.environ.get("COINGECKO_API_KEY", "").strip()
    if api_key:
        headers["x-cg-demo-api-key"] = api_key
    data = _get(url, headers=headers or None).json()
    prices = data.get("prices")
    if not isinstance(prices, list) or not prices:
        raise RuntimeError(f"coingecko: no prices for '{coin_id}'")
    out: List[Point] = []
    for pair in prices:
        try:
            ms, price = pair[0], pair[1]
            date = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            value = _safe_float(str(price))
        except (TypeError, IndexError, ValueError):
            continue
        if value is not None:
            out.append((date, value))
    if not out:
        raise RuntimeError(f"coingecko: no usable points for '{coin_id}'")
    return _dedupe_sorted(out)


# --------------------------------------------------------------------------- #
# Registry                                                                     #
# --------------------------------------------------------------------------- #
GROUP_COLORS = {
    "Equities": "#FF6A00", "Rates": "#DB4B45", "Emerging Markets": "#B23A85",
    "Commodities": "#8E23C4", "Crypto": "#6A0DFF",
}

_ADAPTERS = {
    "twelvedata": fetch_twelvedata,
    "stooq": fetch_stooq,
    "fred": fetch_fred,
    "coingecko": fetch_coingecko,
}


@dataclass(frozen=True)
class Instrument:
    id: str
    name: str
    group: str
    unit: str
    source: str            # declared primary source
    symbol: str
    decimals: int
    order: int
    fetch: Callable[[], Tuple[List[Point], str]] = field(compare=False, repr=False, default=None)  # type: ignore

    @property
    def color(self) -> str:
        return GROUP_COLORS[self.group]


def _make(*, id, name, group, unit, source, symbol, decimals, order, fallback=None) -> Instrument:
    primary = lambda: _ADAPTERS[source](symbol)  # noqa: E731
    fb_source, fb_symbol = fallback if fallback else (None, None)
    fb = (lambda: _ADAPTERS[fb_source](fb_symbol)) if fallback else None

    def fetch() -> Tuple[List[Point], str]:
        """Return (points, source_used). Falls back only if the primary fails.
        If both fail, raise a combined (already-redacted) error naming each cause,
        so the log/board shows *why* instead of a bare 'RuntimeError'."""
        try:
            return primary(), source
        except Exception as e_primary:
            if fb is None:
                raise
            try:
                return fb(), fb_source
            except Exception as e_fb:
                raise RuntimeError(f"{source} → {e_primary}  ||  {fb_source} → {e_fb}")

    return Instrument(id=id, name=name, group=group, unit=unit, source=source,
                      symbol=symbol, decimals=decimals, order=order, fetch=fetch)


# Order mirrors the reference screenshot.
# VERIFY on first run with your key: Twelve Data index symbols DJI / SPX / IXIC and
# ETF symbols EEM / CEW. Any the free tier rejects will auto-fall back to Stooq.
INSTRUMENTS: List[Instrument] = [
    _make(id="dow_jones", name="Dow Jones",             group="Equities",         unit="index",       source="twelvedata", symbol="DJI",     decimals=2, order=1,  fallback=("stooq", "^dji")),
    _make(id="sp500",     name="S&P 500",               group="Equities",         unit="index",       source="twelvedata", symbol="SPX",     decimals=2, order=2,  fallback=("stooq", "^spx")),
    _make(id="nasdaq",    name="NASDAQ Composite",      group="Equities",         unit="index",       source="twelvedata", symbol="IXIC",    decimals=2, order=3,  fallback=("stooq", "^ndq")),
    _make(id="us10y",     name="US 10Y Treasury Yield", group="Rates",            unit="percent",     source="twelvedata", symbol="US10Y",   decimals=3, order=4,  fallback=("fred", "DGS10")),
    _make(id="eem",       name="MSCI EM Index (EEM)",   group="Emerging Markets", unit="usd",         source="twelvedata", symbol="EEM",     decimals=2, order=5,  fallback=("stooq", "eem.us")),
    _make(id="cew",       name="MSCI EM Ccy Idx (CEW)", group="Emerging Markets", unit="usd",         source="twelvedata", symbol="CEW",     decimals=2, order=6,  fallback=("stooq", "cew.us")),
    _make(id="usdcny",    name="USD/CNY",               group="Emerging Markets", unit="fx",          source="twelvedata", symbol="USD/CNY", decimals=4, order=7,  fallback=("fred", "DEXCHUS")),
    _make(id="brent",     name="Brent Crude Oil",       group="Commodities",      unit="usd_per_bbl", source="fred",       symbol="DCOILBRENTEU", decimals=2, order=8),  # TD commodities are paid; FRED is keyless
    _make(id="gold",      name="Spot Gold (XAU)",       group="Commodities",      unit="usd",         source="twelvedata", symbol="XAU/USD", decimals=2, order=9,  fallback=("stooq", "xauusd")),
    _make(id="btc",       name="Bitcoin (BTC/USD)",     group="Crypto",           unit="usd",         source="twelvedata", symbol="BTC/USD", decimals=2, order=10, fallback=("coingecko", "bitcoin")),
]

INSTRUMENTS.sort(key=lambda x: x.order)
