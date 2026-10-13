"""Horaires TaM d'un jour ordinaire, compacts, pour le calcul transports en commun dans le navigateur.

Lit le GTFS (data/gtfs_tam.zip) et écrit site/data/horaires.bin : les arrêts (position dans le repère de la carte)
et, ligne par ligne, les « missions » (suites d'arrêts identiques) avec les horaires de chaque course, pour le
même jour de référence que la carte et que r5_isochrones.py (un mardi ou jeudi ordinaire). Comme pour r5py, les
courses sur réservation (TAD) sont retirées, et un arrêt sur réservation d'une course régulière n'est ni montée
ni descente.

Format : JSON compressé zlib,
  {"jour": "AAAAMMJJ", "arrets": [[x, y], …],
   "missions": [[ligne, [arrêts…], [montée possible 0/1…], [descente possible 0/1…],
                 [[arrivée, départ, arrivée, départ, …] en secondes depuis minuit, une liste par course]], …]}
Les courses d'une mission sont triées par heure de départ.

Usage :
  python tools/horaires_site.py
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
import zlib
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import build_data  # noqa: E402

OUTPUT = ROOT / "site" / "data" / "horaires.bin"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gtfs", type=Path, default=build_data.DATA_DIR / "gtfs_tam.zip")
    parser.add_argument("--sortie", type=Path, default=OUTPUT)
    args = parser.parse_args()

    with zipfile.ZipFile(args.gtfs) as archive:
        calendar_dates = list(build_data.read_gtfs_table(archive, "calendar_dates.txt"))
        day = build_data.pick_reference_date(calendar_dates)
        active = {row["service_id"] for row in calendar_dates if row["date"] == day and row["exception_type"] == "1"}
        trips = {
            row["trip_id"]: row
            for row in build_data.read_gtfs_table(archive, "trips.txt")
            if row["service_id"] in active and not (row.get("TAD") or "").strip()
        }
        stops = {row["stop_id"]: row for row in build_data.read_gtfs_table(archive, "stops.txt")}
        passages = defaultdict(list)
        for row in build_data.read_gtfs_table(archive, "stop_times.txt"):
            if row["trip_id"] in trips:
                passages[row["trip_id"]].append(row)

    stop_index, stop_list = {}, []
    missions = {}
    removed = 0
    for trip_id, rows in passages.items():
        rows.sort(key=lambda row: int(row["stop_sequence"]))
        on_demand = [(row.get("pickup_type") or "0").strip() == "2" or (row.get("drop_off_type") or "0").strip() == "2" for row in rows]
        if all(on_demand):
            removed += 1
            continue
        sequence = []
        for row in rows:
            if row["stop_id"] not in stop_index:
                stop = stops[row["stop_id"]]
                stop_index[row["stop_id"]] = len(stop_list)
                x, y = build_data.lonlat_to_xy(float(stop["stop_lon"]), float(stop["stop_lat"]))
                stop_list.append([round(x, 1), round(y, 1)])
            sequence.append(stop_index[row["stop_id"]])
        pickup = [int(not demand and (row.get("pickup_type") or "0").strip() != "1") for row, demand in zip(rows, on_demand)]
        dropoff = [int(not demand and (row.get("drop_off_type") or "0").strip() != "1") for row, demand in zip(rows, on_demand)]
        times = []
        for row in rows:
            times += [build_data.parse_time(row["arrival_time"]), build_data.parse_time(row["departure_time"])]
        key = (trips[trip_id]["route_id"], tuple(sequence), tuple(pickup), tuple(dropoff))
        missions.setdefault(key, []).append(times)

    out = []
    for (route, sequence, pickup, dropoff), courses in sorted(missions.items()):
        courses.sort(key=lambda times: times[1])
        out.append([route, list(sequence), list(pickup), list(dropoff), courses])
    body = json.dumps({"jour": day, "arrets": stop_list, "missions": out}, separators=(",", ":"))
    data = zlib.compress(body.encode(), 9)
    args.sortie.write_bytes(data)
    count = sum(len(courses) for courses in missions.values())
    print(f"Jour {day} : {len(stop_list)} arrêts, {len(out)} missions, {count} courses "
          f"({removed} entièrement sur réservation retirées) → {args.sortie} ({len(data) / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
