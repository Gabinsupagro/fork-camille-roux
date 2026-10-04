#!/usr/bin/env python3
"""Build the compact JSON bundle for the Montpellier tram/bus commute map."""

from __future__ import annotations

import csv
import io
import json
import math
import statistics
import zipfile
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DATA_PATH = ROOT / "site" / "data" / "commute_map_data.json"

LAT0 = 43.61
LAND_PAD_METERS = 1200.0
VIEW_PAD_METERS = 900.0

GRID_CELL_METERS = 200.0
# Walking speed (4.5 km/h), applied to straight-line distances: tram lines run along straight avenues.
WALK_METERS_PER_MINUTE = 75.0
# Tram and bus stops are at street level: no corridors or escalators.
STATION_ACCESS_PENALTY = 0.0
CELL_NEAREST_STATIONS = 5
CELL_NEAREST_TRAM_STATIONS = 3
ORIGIN_NEAREST_STATIONS = 6
DEFAULT_BOARD_WAIT = 5.0
TRANSFER_WALK = 1.5
INTER_COMPLEX_WALK_RADIUS = 450.0
STOP_GROUP_RADIUS = 350.0
MIN_RIDE_MINUTES = 0.4
MIN_WAIT = 1.0
MAX_WAIT = 15.0
# Daytime window used to measure headways and ride times (weekday, 7h–20h).
SERVICE_WINDOW = (7 * 3600, 20 * 3600)
MIN_RING_DISTANCE = 45.0
MIN_LINE_DISTANCE = 25.0
MIN_PARK_AREA = 20_000.0
TRAM_ROUTE_REFS = {"1": "1", "2": "2", "3": "3", "4A": "4", "4B": "4", "5": "5"}

Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]


def lonlat_to_xy(lon: float, lat: float) -> Point:
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = meters_per_deg_lat * math.cos(math.radians(LAT0))
    return lon * meters_per_deg_lon, lat * meters_per_deg_lat


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def round_point(point: Point) -> List[float]:
    return [round(point[0], 1), round(point[1], 1)]


def dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def ring_area(ring: Sequence[Point]) -> float:
    area = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def polygon_centroid(ring: Sequence[Point]) -> Point:
    area = ring_area(ring) or 1.0
    factor = 1.0 / (6.0 * area)
    cx = cy = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx * factor, cy * factor


def simplify_polyline(points: Sequence[Point], min_distance: float) -> List[Point]:
    if len(points) <= 2:
        return list(points)
    simplified = [points[0]]
    for point in points[1:-1]:
        if dist(point, simplified[-1]) >= min_distance:
            simplified.append(point)
    if points[-1] != simplified[-1]:
        simplified.append(points[-1])
    return simplified


def simplify_ring(ring: Sequence[Point], min_distance: float) -> Ring:
    if len(ring) <= 4:
        return list(ring)
    core = list(ring[:-1]) if ring[0] == ring[-1] else list(ring)
    simplified = [core[0]]
    for point in core[1:]:
        if dist(point, simplified[-1]) >= min_distance:
            simplified.append(point)
    if len(simplified) < 3:
        simplified = core[:3]
    simplified.append(simplified[0])
    return simplified


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        intersects = (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
        if intersects:
            inside = not inside
    return inside


def point_in_polygon(point: Point, polygon: Polygon) -> bool:
    if not polygon or not point_in_ring(point, polygon[0]):
        return False
    return not any(point_in_ring(point, hole) for hole in polygon[1:])


def point_in_multipolygon(point: Point, multipolygon: MultiPolygon) -> bool:
    return any(point_in_polygon(point, polygon) for polygon in multipolygon)


def multipolygon_bounds(multipolygon: MultiPolygon, pad: float) -> Tuple[float, float, float, float]:
    xs = [x for polygon in multipolygon for ring in polygon for x, _ in ring]
    ys = [y for polygon in multipolygon for ring in polygon for _, y in ring]
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def coords_to_polygons(geometry: dict, min_distance: float = MIN_RING_DISTANCE) -> MultiPolygon:
    geom_type = geometry["type"]
    coords = geometry["coordinates"]
    if geom_type == "Polygon":
        polygons = [coords]
    elif geom_type == "MultiPolygon":
        polygons = coords
    else:
        return []
    converted: MultiPolygon = []
    for rings in polygons:
        polygon: Polygon = []
        for ring in rings:
            points = [lonlat_to_xy(lon, lat) for lon, lat in ring]
            if len(points) < 4:
                continue
            if points[0] != points[-1]:
                points.append(points[0])
            polygon.append(simplify_ring(points, min_distance))
        if polygon:
            converted.append(polygon)
    return converted


def serialize_polygon(polygon: Polygon) -> List[List[List[float]]]:
    return [[round_point(point) for point in ring] for ring in polygon]


# --- Land, water, parks -----------------------------------------------------


def extract_communes() -> Tuple[List[dict], MultiPolygon]:
    payload = load_json(DATA_DIR / "communes_3m.geojson")
    communes = []
    all_polygons: MultiPolygon = []
    for feature in sorted(payload["features"], key=lambda f: f["properties"]["nom"]):
        polygons = coords_to_polygons(feature["geometry"])
        if not polygons:
            continue
        largest = max((polygon[0] for polygon in polygons), key=lambda ring: abs(ring_area(ring)))
        communes.append(
            {
                "name": feature["properties"]["nom"],
                "polygons": [serialize_polygon(polygon) for polygon in polygons],
                "outline": [[round_point(point) for point in polygon[0]] for polygon in polygons],
                "label": round_point(polygon_centroid(largest)),
            }
        )
        all_polygons.extend(polygons)
    return communes, all_polygons


def closed_way_ring(element: dict) -> Ring | None:
    geometry = element.get("geometry") or []
    if len(geometry) < 4:
        return None
    first, last = geometry[0], geometry[-1]
    if (first["lon"], first["lat"]) != (last["lon"], last["lat"]):
        return None
    return [lonlat_to_xy(node["lon"], node["lat"]) for node in geometry]


def extract_water_and_parks(bounds: Tuple[float, float, float, float]) -> Tuple[MultiPolygon, MultiPolygon, MultiPolygon]:
    """Return (lagoons that are not land, other water shown on the map, parks)."""
    payload = load_json(DATA_DIR / "osm_water_parks.json")
    min_x, min_y, max_x, max_y = bounds
    lagoons: MultiPolygon = []
    water: MultiPolygon = []
    parks: MultiPolygon = []
    for element in payload["elements"]:
        if element["type"] != "way":
            continue
        tags = element.get("tags", {})
        ring = closed_way_ring(element)
        if not ring:
            continue
        xs = [x for x, _ in ring]
        ys = [y for _, y in ring]
        if max(xs) < min_x or min(xs) > max_x or max(ys) < min_y or min(ys) > max_y:
            continue
        area = abs(ring_area(ring))
        if tags.get("natural") == "water":
            if area < 15_000:
                continue
            target = lagoons if tags.get("water") == "lagoon" else water
            target.append([simplify_ring(ring, MIN_RING_DISTANCE if area > 1e6 else 12.0)])
        elif tags.get("leisure") == "park" and area >= MIN_PARK_AREA:
            parks.append([simplify_ring(ring, 15.0)])
    return lagoons, water, parks


# --- GTFS -------------------------------------------------------------------


def read_gtfs_table(archive: zipfile.ZipFile, name: str) -> Iterable[dict]:
    with archive.open(name) as handle:
        yield from csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig"))


def parse_time(value: str) -> int:
    hours, minutes, seconds = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def pick_reference_date(calendar_dates: Sequence[dict]) -> str:
    """A plain school-term Tuesday or Thursday: the most common set of services among those days.

    Picking the busiest day instead would favour holidays with works and substitution buses.
    """
    services: Dict[str, set] = defaultdict(set)
    for row in calendar_dates:
        if row["exception_type"] == "1":
            services[row["date"]].add(row["service_id"])
    weekdays = sorted(
        day for day in services if date(int(day[:4]), int(day[4:6]), int(day[6:])).weekday() in (1, 3)
    )
    signatures = Counter(frozenset(services[day]) for day in weekdays)
    typical = signatures.most_common(1)[0][0]
    return next(day for day in weekdays if frozenset(services[day]) == typical)


def normalize_name(name: str) -> str:
    return " ".join(name.lower().replace("-", " ").replace("’", "'").split())


def group_stops(stops: Dict[str, dict], used_stop_ids: set) -> Tuple[List[dict], Dict[str, int]]:
    """Merge stops sharing a name and lying close together into one complex."""
    by_name: Dict[str, List[str]] = defaultdict(list)
    for stop_id in used_stop_ids:
        by_name[normalize_name(stops[stop_id]["stop_name"])].append(stop_id)

    complexes: List[dict] = []
    complex_of: Dict[str, int] = {}
    for _, stop_ids in sorted(by_name.items()):
        points = {stop_id: lonlat_to_xy(float(stops[stop_id]["stop_lon"]), float(stops[stop_id]["stop_lat"])) for stop_id in stop_ids}
        clusters: List[List[str]] = []
        for stop_id in sorted(stop_ids):
            merged = None
            for cluster in clusters:
                if any(dist(points[stop_id], points[other]) <= STOP_GROUP_RADIUS for other in cluster):
                    if merged is None:
                        cluster.append(stop_id)
                        merged = cluster
                    else:
                        merged.extend(cluster)
                        cluster.clear()
            clusters = [cluster for cluster in clusters if cluster]
            if merged is None:
                clusters.append([stop_id])
        for cluster in clusters:
            xs = [points[stop_id][0] for stop_id in cluster]
            ys = [points[stop_id][1] for stop_id in cluster]
            index = len(complexes)
            names = Counter(stops[stop_id]["stop_name"] for stop_id in cluster)
            complexes.append(
                {
                    "id": min(cluster),
                    "name": names.most_common(1)[0][0],
                    "point": (sum(xs) / len(xs), sum(ys) / len(ys)),
                    "routes": set(),
                }
            )
            for stop_id in cluster:
                complex_of[stop_id] = index
    return complexes, complex_of


def extract_network():
    with zipfile.ZipFile(DATA_DIR / "gtfs_tam.zip") as archive:
        routes = {row["route_id"]: row for row in read_gtfs_table(archive, "routes.txt")}
        stops = {row["stop_id"]: row for row in read_gtfs_table(archive, "stops.txt")}
        calendar_dates = list(read_gtfs_table(archive, "calendar_dates.txt"))
        reference_date = pick_reference_date(calendar_dates)
        active_services = {
            row["service_id"] for row in calendar_dates if row["date"] == reference_date and row["exception_type"] == "1"
        }
        trips = {
            row["trip_id"]: row
            for row in read_gtfs_table(archive, "trips.txt")
            if row["service_id"] in active_services and not (row.get("TAD") or "").strip()
        }
        stop_times: Dict[str, List[Tuple[int, str, int, int]]] = defaultdict(list)
        for row in read_gtfs_table(archive, "stop_times.txt"):
            if row["trip_id"] not in trips:
                continue
            stop_times[row["trip_id"]].append(
                (int(row["stop_sequence"]), row["stop_id"], parse_time(row["arrival_time"]), parse_time(row["departure_time"]))
            )

    used_stop_ids = {stop_id for sequence in stop_times.values() for _, stop_id, _, _ in sequence}
    complexes, complex_of = group_stops(stops, used_stop_ids)

    ride_samples: Dict[Tuple[int, int, str], List[float]] = defaultdict(list)
    departures: Dict[Tuple[int, str], Counter] = defaultdict(Counter)
    window_start, window_end = SERVICE_WINDOW
    for trip_id, sequence in stop_times.items():
        trip = trips[trip_id]
        route_id = trip["route_id"]
        sequence.sort()
        for (_, stop_a, _, dep_a), (_, stop_b, arr_b, _) in zip(sequence, sequence[1:]):
            a, b = complex_of[stop_a], complex_of[stop_b]
            complexes[a]["routes"].add(route_id)
            complexes[b]["routes"].add(route_id)
            if a == b or not window_start <= dep_a < window_end:
                continue
            ride_samples[(a, b, route_id)].append(max(0, arr_b - dep_a) / 60.0)
            departures[(a, route_id)][trip["direction_id"]] += 1

    edges = {key: max(MIN_RIDE_MINUTES, statistics.median(samples)) for key, samples in ride_samples.items()}
    window_minutes = (window_end - window_start) / 60.0
    waits: Dict[Tuple[int, str], float] = {}
    for key, per_direction in departures.items():
        mean_departures = sum(per_direction.values()) / len(per_direction)
        headway = window_minutes / mean_departures
        waits[key] = round(min(MAX_WAIT, max(MIN_WAIT, headway / 2.0)), 2)

    route_info = {
        route_id: {
            "mode": "tram" if row["route_type"] == "0" else "bus",
            "color": f"#{(row.get('route_color') or '888888').strip().lstrip('#')}",
            "name": row["route_short_name"],
        }
        for route_id, row in routes.items()
    }
    return reference_date, complexes, edges, waits, route_info


def build_graph(complexes: Sequence[dict], edges: Dict[Tuple[int, int, str], float], waits: Dict[Tuple[int, str], float]):
    route_states: List[dict] = []
    station_states: List[List[int]] = [[] for _ in complexes]
    lookup: Dict[Tuple[int, str], int] = {}
    for station_index, station in enumerate(complexes):
        for route_id in sorted(station["routes"]):
            state_index = len(route_states)
            route_states.append(
                {
                    "stationIndex": station_index,
                    "routeId": route_id,
                    "wait": waits.get((station_index, route_id), DEFAULT_BOARD_WAIT),
                }
            )
            station_states[station_index].append(state_index)
            lookup[(station_index, route_id)] = state_index

    adjacency: List[List[List[float]]] = [[] for _ in route_states]

    def add_edge(src: int, dst: int, weight: float) -> None:
        adjacency[src].append([dst, round(weight, 2)])

    # Ride edges are directed: one-way loops (line 4) and branches stay correct.
    for (a, b, route_id), minutes in edges.items():
        add_edge(lookup[(a, route_id)], lookup[(b, route_id)], minutes)

    # Changing line inside a stop: short walk plus waiting for the next vehicle.
    for states in station_states:
        for src in states:
            for dst in states:
                if src != dst:
                    add_edge(src, dst, TRANSFER_WALK + route_states[dst]["wait"])

    # Walking to a nearby stop with another name.
    for i, a in enumerate(complexes):
        for j, b in enumerate(complexes):
            if i == j:
                continue
            meters = dist(a["point"], b["point"])
            if meters > INTER_COMPLEX_WALK_RADIUS:
                continue
            walk = meters / WALK_METERS_PER_MINUTE + TRANSFER_WALK
            for src in station_states[i]:
                for dst in station_states[j]:
                    if route_states[src]["routeId"] != route_states[dst]["routeId"]:
                        add_edge(src, dst, walk + route_states[dst]["wait"])
    return route_states, station_states, adjacency


# --- Tram geometry ----------------------------------------------------------


def extract_tram_routes(route_info: Dict[str, dict]) -> List[dict]:
    payload = load_json(DATA_DIR / "tram_osm.json")
    seen: Dict[str, set] = defaultdict(set)
    shapes = []
    for relation in sorted(payload["elements"], key=lambda item: item["id"]):
        route_id = TRAM_ROUTE_REFS.get(relation.get("tags", {}).get("ref", ""))
        if not route_id:
            continue
        for member in relation.get("members", []):
            if member["type"] != "way" or member.get("role") not in ("", None) or member["ref"] in seen[route_id]:
                continue
            seen[route_id].add(member["ref"])
            points = [lonlat_to_xy(node["lon"], node["lat"]) for node in member.get("geometry", [])]
            if len(points) >= 2:
                shapes.append(
                    {
                        "id": route_id,
                        "color": route_info[route_id]["color"],
                        "points": [round_point(p) for p in simplify_polyline(points, MIN_LINE_DISTANCE)],
                    }
                )
    return shapes


# --- Grid -------------------------------------------------------------------


def build_grid(land: MultiPolygon, lagoons: MultiPolygon, stations: Sequence[dict], bounds, cols: int, rows: int):
    min_x, min_y, max_x, max_y = bounds
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows
    tram_indexes = [index for index, station in enumerate(stations) if station["tram"]]
    cells = []
    mask = [-1] * (cols * rows)
    for row in range(rows):
        for col in range(cols):
            point = (min_x + (col + 0.5) * cell_w, min_y + (row + 0.5) * cell_h)
            if not point_in_multipolygon(point, land) or point_in_multipolygon(point, lagoons):
                continue
            ranked = sorted(((dist(point, station["point"]), index) for index, station in enumerate(stations)))
            nearest = {index: meters for meters, index in ranked[:CELL_NEAREST_STATIONS]}
            tram_ranked = sorted((dist(point, stations[index]["point"]), index) for index in tram_indexes)
            for meters, index in tram_ranked[:CELL_NEAREST_TRAM_STATIONS]:
                nearest[index] = meters
            mask[row * cols + col] = len(cells)
            cells.append(
                {
                    "row": row,
                    "col": col,
                    "point": round_point(point),
                    "access": [[index, round(meters, 1)] for index, meters in sorted(nearest.items(), key=lambda item: item[1])],
                }
            )
    return cells, mask


def main() -> None:
    communes, land = extract_communes()
    bounds = multipolygon_bounds(land, LAND_PAD_METERS)
    cols = round((bounds[2] - bounds[0]) / GRID_CELL_METERS)
    rows = round((bounds[3] - bounds[1]) / GRID_CELL_METERS)
    lagoons, water, parks = extract_water_and_parks(bounds)

    reference_date, complexes, edges, waits, route_info = extract_network()
    route_states, station_states, adjacency = build_graph(complexes, edges, waits)
    routes = extract_tram_routes(route_info)

    stations = [
        {
            "id": station["id"],
            "name": station["name"],
            "point": station["point"],
            "routes": sorted(station["routes"], key=lambda r: (len(r), r)),
            "tram": any(route_info[route_id]["mode"] == "tram" for route_id in station["routes"]),
        }
        for station in complexes
    ]
    tram_points = [station["point"] for station in stations if station["tram"]]
    view_bounds = (
        min(x for x, _ in tram_points) - VIEW_PAD_METERS,
        min(y for _, y in tram_points) - VIEW_PAD_METERS,
        max(x for x, _ in tram_points) + VIEW_PAD_METERS,
        max(y for _, y in tram_points) + VIEW_PAD_METERS,
    )
    cells, mask = build_grid(land, lagoons, stations, bounds, cols, rows)

    output = {
        "meta": {
            "lat0": LAT0,
            "referenceDate": reference_date,
            "bounds": [round(v, 1) for v in bounds],
            "viewBounds": [round(v, 1) for v in view_bounds],
            "gridCols": cols,
            "gridRows": rows,
            "walkMetersPerMinute": WALK_METERS_PER_MINUTE,
            "stationAccessPenalty": STATION_ACCESS_PENALTY,
            "originStationCount": ORIGIN_NEAREST_STATIONS,
            "cellNearestStations": CELL_NEAREST_STATIONS,
            "defaultBoardWait": DEFAULT_BOARD_WAIT,
        },
        "boroughs": communes,
        "water": [serialize_polygon(polygon) for polygon in lagoons + water],
        "parks": [serialize_polygon(polygon) for polygon in parks],
        "routes": routes,
        "routeInfo": route_info,
        "stations": [{**station, "point": round_point(station["point"])} for station in stations],
        "routeStates": route_states,
        "stationStates": station_states,
        "adjacency": adjacency,
        "cells": cells,
        "mask": mask,
    }

    SITE_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SITE_DATA_PATH.write_text(json.dumps(output, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    tram_count = sum(1 for station in stations if station["tram"])
    print(
        f"Wrote {SITE_DATA_PATH} "
        f"({SITE_DATA_PATH.stat().st_size / 1_000_000:.2f} MB, GTFS du {reference_date}, "
        f"{len(stations)} arrêts dont {tram_count} tram, {len(route_states)} states, "
        f"{sum(len(a) for a in adjacency)} edges, {len(cells)} cells ({cols}×{rows}), {len(routes)} tram segments)"
    )


if __name__ == "__main__":
    main()
