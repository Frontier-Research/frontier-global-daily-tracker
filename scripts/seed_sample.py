"""
seed_sample.py — generate synthetic history so the dashboard renders before the
first live refresh. It reuses the REAL pipeline writers (derive/save_store/JSON),
so running it also confirms the output format matches what the front end reads.

This does NOT hit the network. Delete data/ or just let the first scheduled run
overwrite these files with real data.
"""
from __future__ import annotations

import os
import random
from datetime import date, timedelta

import fetch  # reuse the real derive + writers
from sources import INSTRUMENTS

random.seed(7)

START = {
    "dow_jones": 53055.0, "sp500": 7537.0, "nasdaq": 26121.0, "us10y": 4.485,
    "eem": 67.57, "cew": 19.35, "usdcny": 7.10, "brent": 72.54,
    "gold": 4137.6, "btc": 62872.0,
}
VOL = {  # daily stdev as a fraction
    "dow_jones": .008, "sp500": .009, "nasdaq": .011, "us10y": .012,
    "eem": .010, "cew": .004, "usdcny": .002, "brent": .015,
    "gold": .009, "btc": .030,
}
CRYPTO = {"btc"}


def business_days(n: int):
    days, d = [], date(2026, 7, 8)
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    return sorted(days)


def all_days(n: int):
    d0 = date(2026, 7, 8)
    return sorted(d0 - timedelta(days=i) for i in range(n))


def make_series(inst) -> dict[str, float]:
    n = 380
    days = all_days(n) if inst.id in CRYPTO else business_days(260)
    # walk backwards from the known "today" value so the latest matches START
    values = [START[inst.id]]
    for _ in range(len(days) - 1):
        step = 1 + random.gauss(0, VOL[inst.id])
        values.append(values[-1] / step)
    values.reverse()
    return {d.strftime("%Y-%m-%d"): round(v, 6) for d, v in zip(days, values)}


def main() -> None:
    os.makedirs(fetch.SERIES, exist_ok=True)
    store = {inst.id: make_series(inst) for inst in INSTRUMENTS}

    from datetime import datetime, timezone
    now_utc = datetime.now(timezone.utc)
    now_slt = now_utc.astimezone(fetch.SLT)
    rows = []
    for inst in INSTRUMENTS:
        metrics = fetch.derive(store[inst.id])
        series_sorted = sorted(store[inst.id].items())[-fetch.SERIES_CAP:]
        fetch._atomic_write_json(os.path.join(fetch.SERIES, f"{inst.id}.json"), {
            "id": inst.id, "name": inst.name, "group": inst.group, "color": inst.color,
            "unit": inst.unit, "decimals": inst.decimals, "source": inst.source,
            "points": [[d, round(v, 6)] for d, v in series_sorted],
        })
        rows.append({
            "id": inst.id, "name": inst.name, "group": inst.group, "color": inst.color,
            "unit": inst.unit, "decimals": inst.decimals, "source": inst.source,
            "order": inst.order, **metrics, "note": "",
        })

    fetch.save_store(store)
    generated = {
        "generated_utc": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_slt": now_slt.strftime("%Y-%m-%d %H:%M"),
        "generated_slt_long": now_slt.strftime("%A, %d %B %Y · %H:%M"),
    }
    fetch._atomic_write_json(os.path.join(fetch.DATA, "latest.json"), {**generated, "rows": rows})
    fetch._atomic_write_json(os.path.join(fetch.DATA, "meta.json"), {
        **generated,
        "instruments": [{"id": r["id"], "name": r["name"], "last_date": r["last_date"],
                         "note": r["note"], "source": r["source"]} for r in rows],
        "notes": ["SAMPLE DATA — replace by running scripts/fetch.py or the scheduled Action."],
    })
    print("Seeded sample data for", len(rows), "instruments.")


if __name__ == "__main__":
    main()
