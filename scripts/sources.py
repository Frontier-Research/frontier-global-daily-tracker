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


def fetch_yahoo(symbol: str) -> List[Point]:
    """
    Keyless daily history from Yahoo Finance's v8 chart endpoint. Covers every asset
    class we need in one place: indices (^DJI ^GSPC ^IXIC), the 10Y yield (^TNX),
    ETFs (EEM CEW), FX (CNY=X), commodities (BZ=F Brent, GC=F gold) and crypto (BTC-USD).
    Needs a browser-like User-Agent; the chart endpoint requires no auth crumb.
    """
    headers = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")}
    params = {"range": "10y", "interval": "1d"}
    last_exc = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        try:
            data = _get(f"https://{host}/v8/finance/chart/{symbol}",
                        params=params, headers=headers).json()
            chart = data.get("chart") or {}
            if chart.get("error"):
                err = chart["error"]
                desc = err.get("description") if isinstance(err, dict) else err
                raise RuntimeError(f"yahoo: {desc}")
            result = chart.get("result")
            if not result:
                raise RuntimeError("yahoo: empty result")
            r0 = result[0]
            stamps = r0.get("timestamp") or []
            quote = ((r0.get("indicators") or {}).get("quote") or [{}])[0]
            closes = quote.get("close") or []
            out: List[Point] = []
            for ts, close in zip(stamps, closes):
                if close is None:
                    continue
                date = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
                value = _safe_float(str(close))
                if value is not None:
                    out.append((date, value))
            # ^TNX is the 10Y yield; Yahoo has historically quoted it x10 — normalise.
            if symbol.upper() == "^TNX":
                out = [(d, v / 10 if v > 20 else v) for d, v in out]
            if not out:
                raise RuntimeError(f"yahoo: no usable rows for '{symbol}'")
            return _dedupe_sorted(out)
        except Exception as exc:  # noqa: BLE001 - try the alternate host before giving up
            last_exc = exc
    raise RuntimeError(f"yahoo: {last_exc}")


# --------------------------------------------------------------------------- #
# Registry                                                                     #
# --------------------------------------------------------------------------- #
GROUP_COLORS = {
    "Equities": "#FF6A00", "Rates": "#DB4B45", "Emerging Markets": "#B23A85",
    "Commodities": "#8E23C4", "Crypto": "#6A0DFF",
}

_ADAPTERS = {
    "yahoo": fetch_yahoo,
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


def _make(*, id, name, group, unit, sources, decimals, order) -> Instrument:
    """`sources` is an ordered list of (source_name, symbol). fetch() tries each in
    turn and returns the first that responds, so no single provider outage — or a
    cloud-IP block, or a missing key — can blank the board on its own."""
    chain = list(sources)
    primary_source, primary_symbol = chain[0]

    def fetch() -> Tuple[List[Point], str]:
        errors = []
        for src, sym in chain:
            try:
                return _ADAPTERS[src](sym), src
            except Exception as exc:  # noqa: BLE001 - record and try the next link
                errors.append(f"{src} → {exc}")
        raise RuntimeError("  ||  ".join(errors))

    return Instrument(id=id, name=name, group=group, unit=unit, source=primary_source,
                      symbol=primary_symbol, decimals=decimals, order=order, fetch=fetch)


# Order mirrors the reference screenshot. Each instrument lists its source chain in
# priority order. Yahoo is keyless and covers every asset class; FRED stays first where
# it is proven reliable from GitHub Actions (yield, USD/CNY, Brent). Stooq / CoinGecko /
# Twelve Data are later links used only if the earlier ones are unavailable.
INSTRUMENTS: List[Instrument] = [
    _make(id="dow_jones", name="Dow Jones",             group="Equities",         unit="index",       decimals=2, order=1,  sources=[("yahoo", "^DJI"),  ("stooq", "^dji"),   ("twelvedata", "DJI")]),
    _make(id="sp500",     name="S&P 500",               group="Equities",         unit="index",       decimals=2, order=2,  sources=[("yahoo", "^GSPC"), ("stooq", "^spx"),   ("twelvedata", "SPX")]),
    _make(id="nasdaq",    name="NASDAQ Composite",      group="Equities",         unit="index",       decimals=2, order=3,  sources=[("yahoo", "^IXIC"), ("stooq", "^ndq"),   ("twelvedata", "IXIC")]),
    _make(id="us10y",     name="US 10Y Treasury Yield", group="Rates",            unit="percent",     decimals=3, order=4,  sources=[("fred", "DGS10"),  ("yahoo", "^TNX"),   ("twelvedata", "US10Y")]),
    _make(id="eem",       name="MSCI EM Index (EEM)",   group="Emerging Markets", unit="usd",         decimals=2, order=5,  sources=[("yahoo", "EEM"),   ("stooq", "eem.us"), ("twelvedata", "EEM")]),
    _make(id="cew",       name="MSCI EM Ccy Idx (CEW)", group="Emerging Markets", unit="usd",         decimals=2, order=6,  sources=[("yahoo", "CEW"),   ("stooq", "cew.us"), ("twelvedata", "CEW")]),
    _make(id="usdcny",    name="USD/CNY",               group="Emerging Markets", unit="fx",          decimals=4, order=7,  sources=[("fred", "DEXCHUS"),("yahoo", "CNY=X"),  ("twelvedata", "USD/CNY")]),
    _make(id="brent",     name="Brent Crude Oil",       group="Commodities",      unit="usd_per_bbl", decimals=2, order=8,  sources=[("fred", "DCOILBRENTEU"), ("yahoo", "BZ=F")]),
    _make(id="gold",      name="Spot Gold (XAU)",       group="Commodities",      unit="usd",         decimals=2, order=9,  sources=[("yahoo", "GC=F"),  ("stooq", "xauusd"), ("twelvedata", "XAU/USD")]),
    _make(id="btc",       name="Bitcoin (BTC/USD)",     group="Crypto",           unit="usd",         decimals=2, order=10, sources=[("yahoo", "BTC-USD"), ("coingecko", "bitcoin"), ("twelvedata", "BTC/USD")]),
]

INSTRUMENTS.sort(key=lambda x: x.order)
