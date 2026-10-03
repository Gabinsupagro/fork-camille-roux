#!/usr/bin/env python3
"""Download the raw sources used by build_data.py into data/."""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
USER_AGENT = "montpellier-temps-transport/0.1"

GTFS_URL = "https://www.data.gouv.fr/api/1/datasets/r/93a29ce2-cfc8-44ff-b712-bcfd814b7f00"
# Montpellier Méditerranée Métropole (EPCI 243400017).
COMMUNES_URL = "https://geo.api.gouv.fr/epcis/243400017/communes?fields=nom,code&format=geojson&geometry=contour"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
TRAM_QUERY = '[out:json][timeout:110];relation["route"="tram"](43.50,3.70,43.72,4.05);out geom;'
WATER_PARKS_QUERY = (
    "[out:json][timeout:110];("
    'relation["natural"="water"](43.45,3.68,43.75,4.08);'
    'way["natural"="water"]["water"~"lagoon|lake|reservoir|river"](43.45,3.68,43.75,4.08);'
    'relation["leisure"="park"](43.55,3.80,43.66,3.95);'
    'way["leisure"="park"](43.55,3.80,43.66,3.95);'
    'way["natural"="coastline"](43.45,3.68,43.75,4.08);'
    ");out geom;"
)


def download(url: str, data: bytes | None = None) -> bytes:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def overpass(query: str) -> bytes:
    payload = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):
        for url in OVERPASS_URLS:
            try:
                body = download(url, payload)
                json.loads(body)
                return body
            except Exception as error:  # noqa: BLE001 - Overpass is often busy, just retry
                print(f"  {url} failed ({error}), retrying…")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("Overpass unavailable")


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    print("GTFS TaM…")
    (DATA_DIR / "gtfs_tam.zip").write_bytes(download(GTFS_URL))
    print("Communes de la Métropole…")
    (DATA_DIR / "communes_3m.geojson").write_bytes(download(COMMUNES_URL))
    print("Tracés tram (OSM)…")
    (DATA_DIR / "tram_osm.json").write_bytes(overpass(TRAM_QUERY))
    print("Étangs et parcs (OSM)…")
    (DATA_DIR / "osm_water_parks.json").write_bytes(overpass(WATER_PARKS_QUERY))


if __name__ == "__main__":
    main()
