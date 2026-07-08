"""
sources.py — the single source of truth for what we track and where it comes from.

To add, remove, or re-point an instrument you edit ONE place: the INSTRUMENTS list
below. Everything downstream (the Excel store, the JSON the dashboard reads, the
board table, the charts) is generated from this registry, so the front end never
duplicates it.

Each adapter returns a list of (date_str 'YYYY-MM-DD', float) tuples, ascending by
date, already cleaned of missing values. Adapters raise on a hard failure; the
pipeline in fetch.py catches that and keeps the previously stored data intact.

Security notes:
  * Every outbound request uses HTTPS with certificate verification left ON
    (requests' default) and a bounded timeout, so a hung endpoint can't stall a run.
  * We only ever *read* and parse numbers. Nothing from a response is executed,
    eval'd, or written to disk as-is.
  * Values are coerced to float and range-checked before they enter the store.
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

# One shared session with a plain, honest User-Agent and a hard timeout.
_TIMEOUT = 30
_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "frontier-global-daily/1.0 (+github-pages static tracker)"})


# --------------------------------------------------------------------------- #
# Small helpers                                                               #
# --------------------------------------------------------------------------- #
def _get(url: str, *, headers: dict | None = None, retries: int = 3) -> requests.Response:
    """GET with a bounded timeout and gentle exponential backoff on transient errors."""
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            resp = _SESSION.get(url, headers=headers, timeout=_TIMEOUT)
            # 429 / 5xx are worth a retry; everything else we surface immediately.
            if resp.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{resp.status_code} from {url}")
            resp.raise_for_status()
            return resp
        except Exception as exc:  # noqa: BLE001 - deliberately broad, we retry then re-raise
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(2 ** attempt)  # 1s, 2s, 4s
    raise RuntimeError(f"request failed after {retries} attempts: {last_exc}")


def _safe_float(raw: str) -> float | None:
    """Parse a value; return None for blanks and FRED's '.' missing marker."""
    raw = (raw or "").strip()
    if raw in ("", ".", "N/D", "null", "NaN"):
        return None
    try:
        val = float(raw)
    except ValueError:
        return None
    # Guard against absurd values that signal a malformed feed.
    if val != val or abs(val) > 1e12:  # NaN or implausible
        return None
    return val


def _dedupe_sorted(points: List[Point]) -> List[Point]:
    """Keep the last value seen per date, return ascending by date."""
    by_date: dict[str, float] = {}
    for d, v in points:
        by_date[d] = v
    return [(d, by_date[d]) for d in sorted(by_date)]


# --------------------------------------------------------------------------- #
# Adapters                                                                     #
# --------------------------------------------------------------------------- #
def fetch_stooq(symbol: str) -> List[Point]:
    """
    Daily history from Stooq's CSV endpoint.
      Indices:  ^spx  ^dji  ^ndq
      US ETFs:  eem.us  cew.us
      Metals:   xauusd
    Returns the full available daily history (Date,Open,High,Low,Close,Volume).
    """
    url = f"https://stooq.com/q/d/l/?s={symbol.lower()}&i=d"
    text = _get(url).text
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or "Close" not in reader.fieldnames:
        # Stooq returns a plain "Exceeded..." / "No data" line when throttled or unknown.
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
    """
    Daily history from FRED's keyless fredgraph CSV export (no API key = no secret
    to store, smaller attack surface). First column is the date, second the value;
    FRED marks missing observations with '.'.
    """
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    text = _get(url).text
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if len(rows) < 2:
        raise RuntimeError(f"fred: empty response for '{series_id}'")
    out: List[Point] = []
    for row in rows[1:]:  # skip header (observation_date,<ID>)
        if len(row) < 2:
            continue
        date = row[0].strip()
        value = _safe_float(row[1])
        if date and value is not None:
            out.append((date, value))
    if not out:
        raise RuntimeError(f"fred: no usable rows for '{series_id}'")
    return _dedupe_sorted(out)


def fetch_coingecko(coin_id: str, days: int | None = None) -> List[Point]:
    """
    Daily close history from CoinGecko's public market_chart endpoint.
    Above ~90 days the free tier already returns daily granularity, so we take one
    price per UTC calendar day. An optional demo key (env COINGECKO_API_KEY) raises
    the rate limit but is not required for twice-a-day polling.

    Note: the free tier caps history at ~365 days. That is fine here — the Excel
    store is what accumulates the long memory, growing one day at a time on every run.
    """
    days = days or int(os.environ.get("COINGECKO_DAYS", "365"))
    url = (
        f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
        f"?vs_currency=usd&days={days}"
    )
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
# The registry                                                                #
# --------------------------------------------------------------------------- #
# group -> spectrum colour (from the supplied palette, warm -> cool)
GROUP_COLORS = {
    "Equities": "#FF6A00",          # spectrum 1 — orange
    "Rates": "#DB4B45",             # spectrum 2 — red
    "Emerging Markets": "#B23A85",  # spectrum 3 — magenta
    "Commodities": "#8E23C4",       # spectrum 4 — purple
    "Crypto": "#6A0DFF",            # spectrum 5 — violet
}


@dataclass(frozen=True)
class Instrument:
    id: str                 # slug used for filenames + DOM ids
    name: str               # label shown in the board
    group: str              # one of GROUP_COLORS
    unit: str               # index | percent | usd | usd_per_bbl | fx
    source: str             # stooq | fred | coingecko
    symbol: str             # provider-specific ticker / series id
    decimals: int           # display precision
    order: int              # row order in the board (mirrors the reference image)
    fetch: Callable[[], List[Point]] = field(compare=False, repr=False, default=None)  # type: ignore

    @property
    def color(self) -> str:
        return GROUP_COLORS[self.group]


def _adapter(source: str, symbol: str) -> Callable[[], List[Point]]:
    if source == "stooq":
        return lambda: fetch_stooq(symbol)
    if source == "fred":
        return lambda: fetch_fred(symbol)
    if source == "coingecko":
        return lambda: fetch_coingecko(symbol)
    raise ValueError(f"unknown source: {source}")


def _make(**kw) -> Instrument:
    kw["fetch"] = _adapter(kw["source"], kw["symbol"])
    return Instrument(**kw)


# Order + symbols mirror the reference screenshot.
# VERIFY on first run (I could not hit the network while writing this):
#   * Stooq NASDAQ Composite symbol is '^ndq' (NASDAQ-100 is '^ndx').
#   * Stooq gold spot is 'xauusd'.
#   * FRED DEXCHUS is CNY per USD (i.e. USD/CNY).
INSTRUMENTS: List[Instrument] = [
    _make(id="dow_jones", name="Dow Jones",                group="Equities",         unit="index",       source="stooq",     symbol="^dji",          decimals=2, order=1),
    _make(id="sp500",     name="S&P 500",                  group="Equities",         unit="index",       source="stooq",     symbol="^spx",          decimals=2, order=2),
    _make(id="nasdaq",    name="NASDAQ Composite",         group="Equities",         unit="index",       source="stooq",     symbol="^ndq",          decimals=2, order=3),
    _make(id="us10y",     name="US 10Y Treasury Yield",    group="Rates",            unit="percent",     source="fred",      symbol="DGS10",         decimals=3, order=4),
    _make(id="eem",       name="MSCI EM Index (EEM)",      group="Emerging Markets", unit="usd",         source="stooq",     symbol="eem.us",        decimals=2, order=5),
    _make(id="cew",       name="MSCI EM Ccy Idx (CEW)",    group="Emerging Markets", unit="usd",         source="stooq",     symbol="cew.us",        decimals=2, order=6),
    _make(id="usdcny",    name="USD/CNY",                  group="Emerging Markets", unit="fx",          source="fred",      symbol="DEXCHUS",       decimals=4, order=7),
    _make(id="brent",     name="Brent Crude Oil",          group="Commodities",      unit="usd_per_bbl", source="fred",      symbol="DCOILBRENTEU",  decimals=2, order=8),
    _make(id="gold",      name="Spot Gold (XAU)",          group="Commodities",      unit="usd",         source="stooq",     symbol="xauusd",        decimals=2, order=9),
    _make(id="btc",       name="Bitcoin (BTC/USD)",        group="Crypto",           unit="usd",         source="coingecko", symbol="bitcoin",       decimals=2, order=10),
]

INSTRUMENTS.sort(key=lambda x: x.order)
